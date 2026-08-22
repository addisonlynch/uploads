/**
 * In-memory stand-in for the slice of the GitHub REST API the `github-branch` adapter uses:
 * the Contents API, the Git Data blob/tree/commit/ref endpoints, and the recursive tree read.
 *
 * `blobs` is exposed so tests can assert on the RAW paths actually committed (objects and
 * their `.uploads-meta/` sidecars alike), and `requests` records every call so tests can
 * assert on round-trip counts rather than assuming them.
 *
 * Deliberately faithful on three points the adapter exists to handle:
 *  - a `sha` mismatch on an existing path answers 409, like the real conflict
 *  - a repository the token cannot see answers 404, not 403
 *  - `staleReads` replays the read-after-write lag that the real Contents API shows
 */

type Blob = { content: Uint8Array; sha: string };

export type FakeGithubOptions = {
  /** Repos the token can see. A request for anything else 404s, as GitHub does. */
  visibleRepos?: string[];
  /** Number of initial content reads per path that answer 404 despite the blob existing. */
  staleReads?: number;
  /**
   * Move a path's sha once, between the read that fetched it and the PUT that uses it. This is
   * the real stale-sha race: mutating the store from a test before calling upload cannot
   * reproduce it, because the adapter's own read then returns the new sha and the write
   * succeeds first time.
   */
  conflictOnce?: string;
  /** Paths whose content the Contents API omits, as it does above 1 MB. */
  oversized?: string[];
  /** Answer the recursive tree read as truncated. */
  truncatedTree?: boolean;
};

let shaCounter = 0;
const nextSha = () => `sha${(shaCounter += 1).toString().padStart(6, "0")}`;

export class FakeGithub {
  blobs = new Map<string, Blob>();
  branches = new Set<string>();
  requests: { method: string; path: string }[] = [];

  private staleLeft = new Map<string, number>();
  private conflictArmed = true;

  constructor(private readonly options: FakeGithubOptions = {}) {}

  /** Drop-in for `globalThis.fetch`. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const path = url.pathname;
    this.requests.push({ method, path });

    const repoMatch = /^\/repos\/([^/]+\/[^/]+)/.exec(path);
    const repo = repoMatch?.[1];
    if (repo && this.options.visibleRepos && !this.options.visibleRepos.includes(repo)) {
      return this.json(404, { message: "Not Found" });
    }
    if (repo && path === `/repos/${repo}`) return this.json(200, { full_name: repo });

    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (/\/git\/ref\/heads\//.test(path)) {
      const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]);
      return this.branches.has(branch)
        ? this.json(200, { ref: `refs/heads/${branch}` })
        : this.json(404, { message: "Not Found" });
    }
    if (path.endsWith("/git/refs") && method === "POST") {
      this.branches.add(String(body.ref).replace("refs/heads/", ""));
      return this.json(201, {});
    }
    if (path.endsWith("/git/blobs") && method === "POST") {
      const sha = nextSha();
      this.blobs.set(`blob:${sha}`, { content: decode(String(body.content)), sha });
      return this.json(201, { sha });
    }
    if (path.endsWith("/git/trees") && method === "POST") {
      if (!Array.isArray(body.tree) || body.tree.length === 0) {
        return this.json(422, { message: "Invalid tree info" });
      }
      // Materialise the seeded tree so README.md is visible to a later listing, the way it is
      // on a real branch — otherwise the adapter's filter for it is never exercised.
      for (const entry of body.tree as { path: string; sha: string }[]) {
        const seeded = this.blobs.get(`blob:${entry.sha}`);
        if (seeded) this.blobs.set(entry.path, seeded);
      }
      return this.json(201, { sha: nextSha() });
    }
    if (path.endsWith("/git/commits") && method === "POST") {
      return this.json(201, { sha: nextSha() });
    }
    if (/\/git\/trees\//.test(path)) {
      return this.json(200, {
        truncated: this.options.truncatedTree ?? false,
        tree: [...this.blobs.entries()]
          .filter(([key]) => !key.startsWith("blob:"))
          .map(([key, blob]) => ({
            path: key,
            type: "blob",
            sha: blob.sha,
            size: blob.content.byteLength,
          })),
      });
    }
    if (/\/git\/blobs\//.test(path)) {
      const sha = path.split("/git/blobs/")[1];
      const found = [...this.blobs.values()].find((blob) => blob.sha === sha);
      return found
        ? this.json(200, { content: encode(found.content), encoding: "base64" })
        : this.json(404, { message: "Not Found" });
    }

    const key = decodeURIComponent(path.split("/contents/")[1] ?? "");
    if (method === "GET") {
      const blob = this.blobs.get(key);
      if (!blob) {
        // A directory answers with an array of its children rather than a 404.
        const children = [...this.blobs.keys()].filter(
          (candidate) => !candidate.startsWith("blob:") && candidate.startsWith(`${key}/`),
        );
        if (key && children.length > 0) {
          return this.json(
            200,
            children.map((child) => ({ type: "file", path: child, sha: "x", size: 0 })),
          );
        }
        return this.json(404, { message: "Not Found" });
      }
      const stale = this.staleLeft.get(key) ?? this.options.staleReads ?? 0;
      if (stale > 0) {
        this.staleLeft.set(key, stale - 1);
        return this.json(404, { message: "Not Found" });
      }
      // Above 1 MB the real API returns metadata with the content omitted, and the caller has
      // to fall back to the Git Data blob endpoint.
      const omitContent = this.options.oversized?.includes(key) ?? false;
      return this.json(200, {
        type: "file",
        path: key,
        sha: blob.sha,
        size: blob.content.byteLength,
        ...(omitContent ? {} : { content: encode(blob.content), encoding: "base64" }),
      });
    }
    if (method === "PUT") {
      // Move the sha out from under a read that already happened — the genuine race.
      if (this.conflictArmed && this.options.conflictOnce === key && this.blobs.has(key)) {
        this.conflictArmed = false;
        this.blobs.set(key, { content: this.blobs.get(key)!.content, sha: `moved-${nextSha()}` });
      }
      const existing = this.blobs.get(key);
      if (existing && body.sha !== existing.sha) {
        return this.json(409, { message: "does not match", sha: existing.sha });
      }
      if (!existing && body.sha) return this.json(422, { message: "sha given for a new file" });
      const sha = nextSha();
      this.blobs.set(key, { content: decode(String(body.content)), sha });
      this.staleLeft.delete(key);
      return this.json(200, { content: { path: key, sha } });
    }
    if (method === "DELETE") {
      this.blobs.delete(key);
      return this.json(200, {});
    }
    return this.json(404, { message: "Not Found" });
  };

  private json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}
