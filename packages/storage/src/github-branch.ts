import { createStoredFile, FilesError } from "files-sdk";
import type {
  Adapter,
  Body,
  DownloadOptions,
  ListOptions,
  ListResult,
  OperationOptions,
  SignedUpload,
  SignUploadOptions,
  StoredFile,
  UploadOptions,
  UploadResult,
} from "files-sdk";

/**
 * Stores objects on an orphan branch of a GitHub repository, addressed by the same-origin
 * `github.com/<owner>/<repo>/blob/<branch>/<key>?raw=true` URL.
 *
 * The point is that such a URL is same-origin, so GitHub's renderer passes it through
 * un-proxied and the viewer's own session fetches it: repo members see the image, everyone
 * else gets a 404. Every other backend here serves from a public CDN, and GitHub fetches an
 * external image through Camo server-side and anonymously, so no external origin can be
 * private and still render.
 *
 * Design notes and tradeoffs live in ../GITHUB-BRANCH-POC.md.
 */

export type GithubBranchConfig = {
  owner: string;
  repo: string;
  /** Orphan branch holding the objects. Created on first upload. Must not contain "/". */
  branch: string;
  /** Token with `contents: write` on the repo. */
  token: string;
  /** Override for GHES. Default https://api.github.com */
  apiBase?: string;
  /** Override for GHES. Default https://github.com */
  siteBase?: string;
  committer?: { name: string; email: string };
};

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_SITE_BASE = "https://github.com";
const DEFAULT_COMMITTER = { name: "uploads", email: "uploads@users.noreply.github.com" };

/**
 * Git stores no per-object metadata, content type or cache-control, but the API sends all
 * three on every upload, so they go in a JSON sidecar. The suffix sits beside the object
 * rather than under a reserved root so the workspace prefix still confines it (a sidecar
 * under `.uploads-meta/` would escape `prefix`, breaking prefix-confinement.test.ts's
 * invariant and orphaning metadata on a "purge everything under this prefix" sweep).
 * `list` hides these, so a key literally ending in this suffix is not addressable.
 */
const SIDECAR_SUFFIX = ".uploads-meta.json";

/**
 * The Contents API sends base64 in a JSON body, so the request is ~1.33x the object and the
 * encode plus the JSON copy is ~2.7x. Well under a Worker's 128 MB, and far under GitHub's
 * own 100 MB blob ceiling.
 */
const MAX_OBJECT_BYTES = 20 * 1024 * 1024;

/** Attempts for a write whose blob sha went stale under it. See `put`. */
const WRITE_ATTEMPTS = 3;

/** Polls for a just-written object to become readable. See `waitUntilReadable`. */
const READ_VISIBILITY_ATTEMPTS = 5;

type ContentsEntry = {
  type: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: string;
};

type TreeEntry = { path: string; type: string; sha: string; size?: number };

type Sidecar = {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  uploadedAt?: number;
};

const README_BODY = (branch: string) => `# ${branch}

Machine-managed storage branch. It holds upload objects so they can be embedded with a
same-origin \`github.com/.../blob/${branch}/<key>?raw=true\` URL, which renders for anyone who
can read this repository and 404s for everyone else.

Orphan by design: it shares no history with the default branch, so nothing here appears in a
normal clone or in the default branch's log.

Do not edit by hand. Reclaiming space means deleting and recreating this branch rather than
deleting files from it, since old blobs stay reachable by sha.
`;

async function toBytes(body: Body): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  // ReadableStream — the Contents API has no streaming path, so it has to be buffered.
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) exceeds the argument limit on large objects.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\n/g, ""));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** Keys are path segments; encode each so spaces and unicode survive, but keep the slashes. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function guessType(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    json: "application/json",
    txt: "text/plain",
  };
  return types[ext] ?? "application/octet-stream";
}

/**
 * A typed NotFound rather than a bare throw: `FilesError.wrap` would otherwise classify it as
 * "Provider", which the SDK presumes transient and retries.
 */
function notFound(key: string): FilesError {
  return new FilesError("NotFound", `no such object: ${key}`, undefined, { permanent: true });
}

function githubFailure(error: unknown): { status?: number; body?: string } {
  if (error instanceof FilesError && typeof error.cause === "object" && error.cause !== null) {
    return error.cause as { status?: number; body?: string };
  }
  return {};
}

export function githubBranch(config: GithubBranchConfig): Adapter<GithubBranchConfig> {
  if (config.branch.includes("/")) {
    // A slash would have to survive both the `?ref=` query and a URL path position, where it
    // means different things. Refusing beats emitting a URL that silently 404s.
    throw new FilesError("Provider", `branch must not contain "/": ${config.branch}`, undefined, {
      permanent: true,
    });
  }

  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const committer = config.committer ?? DEFAULT_COMMITTER;
  const repoPath = `${config.owner}/${config.repo}`;
  const refQuery = `?ref=${encodeURIComponent(config.branch)}`;
  let branchReady = false;
  let repoChecked: Promise<unknown> | undefined;

  /**
   * GitHub answers 404 rather than 403 for a repository the token cannot see, so a bare 404
   * on a key is ambiguous: missing object, or no access. Confirming the repo once per adapter
   * removes the ambiguity, and lets every read path treat a later 404 as a genuine absence.
   */
  function ensureRepoVisible(): Promise<unknown> {
    repoChecked ??= call<unknown>(`/repos/${repoPath}`);
    return repoChecked;
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "uploads-github-branch-adapter",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  }

  async function failureFrom(res: Response, path: string, init?: RequestInit): Promise<FilesError> {
    {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      // GitHub answers 404 rather than 403 for a repo the token cannot see, so a 404 on a
      // path we expect to exist is more often a permissions problem than a missing object.
      const hint =
        res.status === 404
          ? ` (a 404 here usually means the token cannot see ${repoPath}, not that the path is missing)`
          : "";
      return new FilesError(
        res.status === 401 || res.status === 403 ? "Unauthorized" : "Provider",
        `GitHub ${init?.method ?? "GET"} ${path} failed: ${res.status}${hint} ${detail}`,
        { status: res.status, body: detail },
        { permanent: res.status >= 400 && res.status < 500 && res.status !== 409 },
      );
    }
  }

  /** A call that must succeed. 404 is an error here, including the "no access" 404. */
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await request(path, init);
    if (!res.ok) throw await failureFrom(res, path, init);
    return (await res.json()) as T;
  }

  /** A read where absence is a legitimate answer. Any other failure still throws. */
  async function probe<T>(path: string): Promise<T | null> {
    const res = await request(path);
    if (res.status === 404) return null;
    if (!res.ok) throw await failureFrom(res, path);
    return (await res.json()) as T;
  }

  async function entryOf(key: string): Promise<ContentsEntry | null> {
    await ensureRepoVisible();
    const found = await probe<ContentsEntry | ContentsEntry[]>(
      `/repos/${repoPath}/contents/${encodePath(key)}${refQuery}`,
    );
    // A directory answers with an array. Treating that as an object would yield an entry with
    // no sha, and the >1 MB read path would then GET /git/blobs/undefined.
    if (!found || Array.isArray(found) || found.type !== "file") return null;
    return found;
  }

  /**
   * Poll until a just-written key is visible to the read path, then give up quietly. The
   * Contents API is read-after-write eventually consistent, and the caller's next move is
   * usually to hand this key's URL to someone; returning early publishes a briefly dead link.
   * Giving up rather than failing is deliberate — the write itself already succeeded.
   */
  async function waitUntilReadable(key: string): Promise<void> {
    for (let attempt = 0; attempt < READ_VISIBILITY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      if (await entryOf(key)) return;
    }
  }

  /** The mirror of `waitUntilReadable`: the read path lags a delete the same way. */
  async function waitUntilGone(key: string): Promise<void> {
    for (let attempt = 0; attempt < READ_VISIBILITY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      if (!(await entryOf(key))) return;
    }
  }

  /**
   * Create the branch as an orphan on first use: a commit with no parents, then the ref. An
   * orphan keeps the objects out of the default branch's ancestry entirely.
   *
   * Seeded with a README rather than created empty because GitHub rejects `tree: []` with a
   * 422, and a branch a human may stumble across should say what it is.
   */
  async function ensureBranch(): Promise<void> {
    if (branchReady) return;
    const refPath = `/repos/${repoPath}/git/ref/heads/${encodeURIComponent(config.branch)}`;
    if (await probe<unknown>(refPath)) {
      branchReady = true;
      return;
    }
    const readme = await call<{ sha: string }>(`/repos/${repoPath}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: toBase64(new TextEncoder().encode(README_BODY(config.branch))),
        encoding: "base64",
      }),
    });
    const tree = await call<{ sha: string }>(`/repos/${repoPath}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        tree: [{ path: "README.md", mode: "100644", type: "blob", sha: readme.sha }],
      }),
    });
    const commit = await call<{ sha: string }>(`/repos/${repoPath}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: `chore: initialise ${config.branch} storage branch`,
        tree: tree.sha,
        parents: [],
        author: committer,
        committer,
      }),
    });
    try {
      await call(`/repos/${repoPath}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${config.branch}`, sha: commit.sha }),
      });
    } catch (error) {
      // A concurrent uploader creating the same branch first is a success, not a clash.
      if (!(await probe<unknown>(refPath))) throw error;
    }
    branchReady = true;
  }

  /** Write one path, replaying against a fresh blob sha when the one we read went stale. */
  async function put(path: string, bytes: Uint8Array, message: string): Promise<string> {
    // Checked before encoding: base64 plus the JSON copy is ~2.7x the object, so encoding
    // first would exhaust a Worker's memory before the guard could fire.
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw new FilesError(
        "Provider",
        `object is ${bytes.byteLength} bytes; this provider caps objects at ${MAX_OBJECT_BYTES}`,
        undefined,
        { permanent: true },
      );
    }
    const content = toBase64(bytes);
    for (let attempt = 0; ; attempt += 1) {
      const existing = await entryOf(path);
      try {
        const result = await call<{ content: ContentsEntry }>(
          `/repos/${repoPath}/contents/${encodePath(path)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              message,
              content,
              branch: config.branch,
              ...(existing ? { sha: existing.sha } : {}),
              author: committer,
              committer,
            }),
          },
        );
        return result.content.sha;
      } catch (error) {
        // 409 is the genuine stale-sha conflict. A 422 naming the sha is the same thing
        // reported differently (the object appeared between our read and our write), and the
        // read that produced the sha is itself eventually consistent, so both are replayable.
        // Matched on GitHub's response body, not on our own message, which embeds the request
        // path — otherwise a key like "shark.png" would read as a conflict.
        const { status, body } = githubFailure(error);
        const replayable = status === 409 || (status === 422 && /sha/i.test(body ?? ""));
        if (!replayable || attempt >= WRITE_ATTEMPTS - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  const sidecarPath = (key: string) => `${key}${SIDECAR_SUFFIX}`;

  async function readSidecar(key: string): Promise<Sidecar> {
    const entry = await entryOf(sidecarPath(key));
    if (!entry?.content || entry.encoding !== "base64") return {};
    try {
      return JSON.parse(new TextDecoder().decode(fromBase64(entry.content))) as Sidecar;
    } catch {
      // A corrupt sidecar must not make the object itself unreadable.
      return {};
    }
  }

  async function writeSidecar(key: string, sidecar: Sidecar): Promise<void> {
    await put(sidecarPath(key), new TextEncoder().encode(JSON.stringify(sidecar)), `meta: ${key}`);
  }

  /** Fetch an object's bytes, following the >1 MB path when the Contents API omits content. */
  async function bytesOf(key: string): Promise<Uint8Array> {
    const entry = await entryOf(key);
    if (!entry) throw notFound(key);
    // The Contents API inlines base64 only up to 1 MB; above that it returns metadata with an
    // empty body. `typeof` rather than truthiness so a legitimately empty object still counts.
    if (typeof entry.content === "string" && entry.encoding === "base64") {
      return fromBase64(entry.content);
    }
    const blob = await call<{ content: string }>(`/repos/${repoPath}/git/blobs/${entry.sha}`);
    return fromBase64(blob.content);
  }

  async function removePath(path: string): Promise<void> {
    const entry = await entryOf(path);
    if (!entry) return;
    await call(`/repos/${repoPath}/contents/${encodePath(path)}`, {
      method: "DELETE",
      body: JSON.stringify({
        message: `delete: ${path}`,
        sha: entry.sha,
        branch: config.branch,
        author: committer,
        committer,
      }),
    });
  }

  return {
    name: "github-branch",
    raw: config,
    // Persisted in the JSON sidecar rather than natively: git has no metadata field, but the
    // API sends these on every upload, so refusing them would make the provider unusable.
    // cacheControl is stored and returned; GitHub still controls the response headers it
    // serves the blob with, so it is a record of intent rather than an enforced directive.
    supportsMetadata: true,
    supportsCacheControl: true,
    supportsServerSideCopy: false,
    // url() returns the stable same-origin URL, which authenticates via the viewer's GitHub
    // session rather than anything in the URL — not a signed URL, so this stays false.
    signedUrl: { supported: false },

    async upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
      const bytes = await toBytes(body);
      await ensureBranch();
      const sha = await put(key, bytes, `upload: ${key}`);

      const contentType = opts?.contentType ?? guessType(key);
      await writeSidecar(key, {
        contentType,
        uploadedAt: Date.now(),
        ...(opts?.cacheControl ? { cacheControl: opts.cacheControl } : {}),
        ...(opts?.metadata && Object.keys(opts.metadata).length ? { metadata: opts.metadata } : {}),
      });

      // Both, not just the object: the sidecar is where contentType and metadata live, and a
      // head() racing its own upload would otherwise report neither.
      await Promise.all([waitUntilReadable(key), waitUntilReadable(sidecarPath(key))]);
      return { key, size: bytes.byteLength, contentType, etag: sha };
    },

    async download(key: string, _opts?: DownloadOptions): Promise<StoredFile> {
      const entry = await entryOf(key);
      if (!entry) throw notFound(key);
      const sidecar = await readSidecar(key);
      const bytes = await bytesOf(key);
      return createStoredFile(
        {
          key,
          size: bytes.byteLength,
          type: sidecar.contentType ?? guessType(key),
          etag: entry.sha,
          lastModified: sidecar.uploadedAt,
          metadata: sidecar.metadata,
        },
        { kind: "buffer", data: bytes },
      );
    },

    async head(key: string, _opts?: OperationOptions): Promise<StoredFile> {
      const entry = await entryOf(key);
      if (!entry) throw notFound(key);
      const sidecar = await readSidecar(key);
      return createStoredFile(
        {
          key,
          size: entry.size,
          type: sidecar.contentType ?? guessType(key),
          etag: entry.sha,
          lastModified: sidecar.uploadedAt,
          metadata: sidecar.metadata,
        },
        // Lazy: head() must not invent a body, and must not pay to fetch one either.
        { kind: "lazy", factory: () => bytesOf(key) },
      );
    },

    async exists(key: string, _opts?: OperationOptions): Promise<boolean> {
      return (await entryOf(key)) !== null;
    },

    async delete(key: string, _opts?: OperationOptions): Promise<void> {
      // Idempotent, like every other adapter: an absent key is a no-op, not an error.
      await removePath(key);
      await removePath(sidecarPath(key));
      await waitUntilGone(key);
    },

    async copy(from: string, to: string, _opts?: OperationOptions): Promise<void> {
      const bytes = await bytesOf(from);
      const sidecar = await readSidecar(from);
      await ensureBranch();
      await put(to, bytes, `copy: ${from} -> ${to}`);
      await writeSidecar(to, sidecar);
      await Promise.all([waitUntilReadable(to), waitUntilReadable(sidecarPath(to))]);
    },

    /**
     * `prefix` is a string prefix over whole keys, not a directory. The recursive tree gives
     * every key in one call, which is both correct for that contract and cheaper than walking
     * directories; `cursor` is an index into the sorted result.
     *
     * GitHub truncates a recursive tree at roughly 100k entries, surfaced as an error rather
     * than a silently short list.
     */
    async list(opts?: ListOptions): Promise<ListResult> {
      await ensureRepoVisible();
      const tree = await probe<{ tree: TreeEntry[]; truncated?: boolean }>(
        `/repos/${repoPath}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`,
      );
      if (!tree) return { items: [] };
      if (tree.truncated) {
        throw new FilesError(
          "Provider",
          `the ${config.branch} tree is too large to list in one call; GitHub truncated it`,
          undefined,
          { permanent: true },
        );
      }
      const prefix = opts?.prefix ?? "";
      const matched = tree.tree
        .filter(
          (entry) =>
            entry.type === "blob" &&
            !entry.path.endsWith(SIDECAR_SUFFIX) &&
            entry.path !== "README.md" &&
            entry.path.startsWith(prefix),
        )
        .sort((a, b) => (a.path < b.path ? -1 : 1));

      const start = opts?.cursor ? Number(opts.cursor) : 0;
      const limit = opts?.limit ?? matched.length;
      const next = start + limit;

      return {
        items: matched.slice(start, next).map((entry) =>
          createStoredFile(
            {
              key: entry.path,
              size: entry.size ?? 0,
              type: guessType(entry.path),
              etag: entry.sha,
            },
            { kind: "lazy", factory: () => bytesOf(entry.path) },
          ),
        ),
        ...(next < matched.length ? { cursor: String(next) } : {}),
      };
    },

    async url(key: string): Promise<string> {
      return githubBranchUrl(config, key);
    },

    async signedUploadUrl(_key: string, _opts: SignUploadOptions): Promise<SignedUpload> {
      throw new FilesError(
        "Provider",
        "github-branch cannot mint upload URLs: GitHub has no presigned-upload primitive",
        undefined,
        { permanent: true },
      );
    },
  };
}

/** The same-origin URL a reviewer's browser fetches with their own GitHub session. */
export function githubBranchUrl(config: GithubBranchConfig, key: string): string {
  const siteBase = (config.siteBase ?? DEFAULT_SITE_BASE).replace(/\/$/, "");
  return `${siteBase}/${config.owner}/${config.repo}/blob/${config.branch}/${encodePath(key)}?raw=true`;
}
