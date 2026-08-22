import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage, publicAndEmbedUrls, publicUrl, type StorageConfig } from "../src/index.js";
import { githubBranch, githubBranchUrl } from "../src/github-branch.js";
import { FakeGithub, type FakeGithubOptions } from "./fake-github.js";

const github = { owner: "acme", repo: "widgets", branch: "uploads-objects", token: "t0ken" };
const base: StorageConfig = { provider: "github-branch", github };

const realFetch = globalThis.fetch;
let api: FakeGithub;

function useFakeGithub(options?: FakeGithubOptions) {
  api = new FakeGithub(options);
  globalThis.fetch = api.fetch as typeof globalThis.fetch;
  return api;
}

beforeEach(() => useFakeGithub());
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createStorage", () => {
  it("builds a Files instance for the provider", () => {
    expect(createStorage(base).adapter.name).toBe("github-branch");
  });

  it("refuses without a github config block", () => {
    expect(() => createStorage({ provider: "github-branch" })).toThrow(/requires a `github`/);
  });

  it("still requires a bucket for r2, now that bucket is optional on the shared type", () => {
    expect(() => createStorage({ provider: "r2" })).toThrow(/requires a `bucket`/);
  });

  it("refuses a branch containing a slash", () => {
    // A slash means one thing in the ?ref= query and another in the URL path, so a branch
    // carrying one would produce a URL that silently 404s.
    expect(() => githubBranch({ ...github, branch: "a/b" })).toThrow(/must not contain/);
  });
});

describe("urls", () => {
  it("builds the same-origin raw URL, including the workspace prefix", () => {
    expect(publicUrl({ ...base, prefix: "ws/" }, "shot.png")).toBe(
      "https://github.com/acme/widgets/blob/uploads-objects/ws/shot.png?raw=true",
    );
  });

  it("encodes key segments without encoding the separators", () => {
    expect(githubBranchUrl(github, "a b/c+d.png")).toBe(
      "https://github.com/acme/widgets/blob/uploads-objects/a%20b/c%2Bd.png?raw=true",
    );
  });

  it("does not percent-encode the branch into a single path segment", () => {
    expect(githubBranchUrl(github, "x.png")).toContain("/blob/uploads-objects/x.png");
  });

  it("reuses the stable URL as the embed URL", () => {
    // Same-origin URLs never pass through Camo, so there is no twin to revalidate against.
    const { url, embedUrl } = publicAndEmbedUrls(base, "shot.png");
    expect(embedUrl).toBe(url);
  });

  it("honours a GHES site base", () => {
    expect(githubBranchUrl({ ...github, siteBase: "https://ghe.acme.dev/" }, "x.png")).toBe(
      "https://ghe.acme.dev/acme/widgets/blob/uploads-objects/x.png?raw=true",
    );
  });
});

describe("upload", () => {
  it("accepts the options the API always sends", async () => {
    // The product's only write path passes contentType, cacheControl and metadata on every
    // call, and the Files wrapper throws for any an adapter does not advertise — so an
    // adapter that declines them cannot store a single byte through the API.
    const store = createStorage(base);
    const result = await store.upload("shot.png", new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
      cacheControl: "public, max-age=60",
      metadata: { uploadedAt: "123" },
    });
    expect(result.size).toBe(3);
    expect(result.contentType).toBe("image/png");
  });

  it("round-trips metadata, contentType and cacheControl through the sidecar", async () => {
    const store = createStorage(base);
    await store.upload("no-extension", new Uint8Array([1]), {
      contentType: "image/webp",
      cacheControl: "immutable",
      metadata: { visibility: "private" },
    });
    const head = await store.head("no-extension");
    expect(head.type).toBe("image/webp");
    expect(head.metadata).toEqual({ visibility: "private" });
    const sidecar = api.blobs.get("no-extension.uploads-meta.json");
    expect(JSON.parse(new TextDecoder().decode(sidecar?.content))).toMatchObject({
      cacheControl: "immutable",
    });
  });

  it("creates the orphan branch on first use, seeded so the tree is not empty", async () => {
    // GitHub rejects `tree: []` with a 422, which the fake reproduces.
    const store = createStorage(base);
    await store.upload("a.txt", "hi");
    expect(api.branches.has("uploads-objects")).toBe(true);
  });

  it("creates the branch once across many uploads", async () => {
    const store = createStorage(base);
    await store.upload("a.txt", "one");
    await store.upload("b.txt", "two");
    const refProbes = api.requests.filter((r) => r.path.includes("/git/ref/heads/"));
    expect(refProbes).toHaveLength(1);
  });

  it("replays a write whose blob sha moved between the read and the PUT", async () => {
    // The fake moves the sha mid-write, which is the actual race: moving it beforehand only
    // means the adapter's own read returns the new value and the first PUT succeeds, so the
    // replay path is never entered.
    useFakeGithub({ conflictOnce: "stable.txt" });
    const store = createStorage(base);
    await store.upload("stable.txt", "first");
    await expect(store.upload("stable.txt", "second")).resolves.toMatchObject({
      key: "stable.txt",
    });
    expect(new TextDecoder().decode(api.blobs.get("stable.txt")?.content)).toBe("second");
    const conflicts = api.requests.filter(
      (r) => r.method === "PUT" && r.path.endsWith("stable.txt"),
    );
    expect(conflicts.length).toBeGreaterThan(2);
  });

  it("gives up on a conflict it cannot win", async () => {
    // The inverse: a replayable status must not retry forever.
    useFakeGithub();
    const store = createStorage(base);
    await store.upload("busy.txt", "first");
    // Every read now reports a sha the PUT will reject.
    const original = api.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await original(input, init);
      const path = new URL(String(input)).pathname;
      if ((init?.method ?? "GET") === "PUT" && path.endsWith("busy.txt")) {
        return new Response(JSON.stringify({ message: "sha does not match" }), { status: 409 });
      }
      return res;
    }) as typeof globalThis.fetch;
    await expect(store.upload("busy.txt", "second")).rejects.toThrow(/409/);
  });

  it('does not mistake a key containing "sha" for a sha conflict', async () => {
    // The replay decision reads GitHub's response body, not our own message — which embeds
    // the request path, so matching on it would replay any 422 on a key like this one.
    useFakeGithub();
    const store = createStorage(base);
    const original = api.fetch;
    let sharkPuts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if ((init?.method ?? "GET") === "PUT" && path.includes("shark")) {
        sharkPuts += 1;
        return new Response(JSON.stringify({ message: "content is too large" }), { status: 422 });
      }
      return original(input, init);
    }) as typeof globalThis.fetch;
    await expect(store.upload("shark.png", "x")).rejects.toThrow(/422/);
    expect(sharkPuts).toBe(1);
  });

  it("waits out a stale read before returning, so the URL it implies resolves", async () => {
    useFakeGithub({ staleReads: 2 });
    const store = createStorage(base);
    await store.upload("slow.txt", "payload");
    await expect(store.exists("slow.txt")).resolves.toBe(true);
  });

  it("waits for the sidecar too, so metadata is not lost to the same lag", async () => {
    // Waiting only on the object would hand back a key whose contentType and metadata read as
    // absent — reintroducing, through the read path, exactly what the sidecar exists to fix.
    useFakeGithub({ staleReads: 2 });
    const store = createStorage(base);
    await store.upload("slow.bin", new Uint8Array([1]), {
      contentType: "image/webp",
      metadata: { state: "after" },
    });
    const head = await store.head("slow.bin");
    expect(head.type).toBe("image/webp");
    expect(head.metadata).toEqual({ state: "after" });
  });

  it("refuses an oversized object before paying to encode it", async () => {
    // Checked on the raw length: base64 plus the JSON copy is ~2.7x, so encoding first would
    // exhaust a Worker's memory before the guard could fire.
    const store = createStorage(base);
    await expect(store.upload("big.bin", new Uint8Array(21 * 1024 * 1024))).rejects.toThrow(
      /caps objects at/,
    );
  });
});

describe("read", () => {
  it("round-trips bytes exactly", async () => {
    const store = createStorage(base);
    const bytes = new Uint8Array([0x89, 0x50, 0, 255, 250, 1]);
    await store.upload("tiny.png", bytes);
    const back = new Uint8Array(await (await store.download("tiny.png")).arrayBuffer());
    expect([...back]).toEqual([...bytes]);
  });

  it("round-trips a zero-byte object", async () => {
    // `entry.content` is "" for an empty file, which is falsy — a truthiness check here
    // would silently divert to the large-blob path.
    const store = createStorage(base);
    await store.upload("empty.bin", new Uint8Array());
    expect((await store.download("empty.bin")).size).toBe(0);
  });

  it("does not fabricate a body for head()", async () => {
    // Returning `new Uint8Array(size)` would hand back that many NUL bytes as real content.
    const store = createStorage(base);
    await store.upload("real.txt", "actual content");
    expect(await (await store.head("real.txt")).text()).toBe("actual content");
  });

  it("head() does not fetch the body until it is asked for", async () => {
    // An eager body would satisfy the assertion above too, so the laziness needs its own
    // check: head of a large object must not pay to download it.
    const store = createStorage(base);
    await store.upload("real.txt", "actual content");
    const before = api.requests.length;
    const file = await store.head("real.txt");
    const afterHead = api.requests.length;
    await file.text();
    expect(api.requests.length).toBeGreaterThan(afterHead);
    expect(afterHead - before).toBeLessThanOrEqual(2);
  });

  it("reads an object the Contents API declines to inline", async () => {
    // Above 1 MB the content field is omitted and the bytes come from the Git Data blob
    // endpoint instead — the branch most likely to be wrong and least likely to be hit.
    useFakeGithub({ oversized: ["big.txt"] });
    const store = createStorage(base);
    await store.upload("big.txt", "pretend this is large");
    expect(await (await store.download("big.txt")).text()).toBe("pretend this is large");
  });

  it("treats a directory-shaped key as absent", async () => {
    // GET /contents/<dir> answers with an array; reading it as an object yields an entry with
    // no sha, and the large-object path then fetches /git/blobs/undefined.
    const store = createStorage(base);
    await store.upload("shots/a.png", "a");
    expect(await store.exists("shots")).toBe(false);
    await expect(store.download("shots")).rejects.toMatchObject({ code: "NotFound" });
  });

  it("throws a typed NotFound rather than a generic provider error", async () => {
    // FilesError.wrap would otherwise code it "Provider", which the SDK retries as transient.
    const store = createStorage(base);
    await expect(store.download("missing.txt")).rejects.toMatchObject({ code: "NotFound" });
  });

  it("reports a repo the token cannot see rather than reading as empty", async () => {
    // GitHub answers 404 for an invisible repo, so a naive 404-means-absent read would have
    // exists() answer false and list() answer empty for a permissions failure.
    useFakeGithub({ visibleRepos: ["someone/else"] });
    const store = createStorage(base);
    await expect(store.upload("a.txt", "hi")).rejects.toThrow(/cannot see acme\/widgets/);
    await expect(store.exists("a.txt")).rejects.toThrow(/cannot see acme\/widgets/);
    await expect(store.list()).rejects.toThrow(/cannot see acme\/widgets/);
  });

  it("codes a real 401 as Unauthorized", async () => {
    // The inverse of the 404 case: an explicit auth rejection must not read as "Provider".
    useFakeGithub();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
      })) as typeof globalThis.fetch;
    const store = createStorage(base);
    await expect(store.exists("a.txt")).rejects.toMatchObject({ code: "Unauthorized" });
  });
});

const seed = async (store: ReturnType<typeof createStorage>) => {
  await store.upload("shots/a.png", "a");
  await store.upload("shots/nested/b.png", "b");
  await store.upload("other/c.png", "c");
};

describe("list", () => {
  it("matches on a string prefix, not a directory level", async () => {
    // `prefix` is a substring match over whole keys; treating it as a directory drops every
    // nested key, which is exactly what the PR-comment promotion flow reads.
    const store = createStorage(base);
    await seed(store);
    const keys = (await store.list({ prefix: "shots/" })).items.map((item) => item.key).sort();
    expect(keys).toEqual(["shots/a.png", "shots/nested/b.png"]);
  });

  it("matches a partial segment", async () => {
    const store = createStorage(base);
    await seed(store);
    expect((await store.list({ prefix: "shots/a" })).items.map((i) => i.key)).toEqual([
      "shots/a.png",
    ]);
  });

  it("keeps sidecars inside the workspace prefix", async () => {
    // A sidecar under a reserved root would escape `prefix`, breaking the confinement the
    // package asserts for r2 and orphaning metadata on a purge of that prefix.
    const store = createStorage({ ...base, prefix: "alpha/" });
    await store.upload("dir/a.txt", "x", { metadata: { k: "v" } });
    expect([...api.blobs.keys()].filter((key) => !key.startsWith("blob:")).sort()).toEqual([
      "README.md",
      "alpha/dir/a.txt",
      "alpha/dir/a.txt.uploads-meta.json",
    ]);
    expect((await store.head("dir/a.txt")).metadata).toEqual({ k: "v" });
  });

  it("refuses to list a tree GitHub truncated", async () => {
    // A short list would silently look like a complete one.
    useFakeGithub({ truncatedTree: true });
    const store = createStorage(base);
    await store.upload("a.txt", "x");
    await expect(store.list()).rejects.toThrow(/truncated/);
  });

  it("hides the sidecars and the seeded README", async () => {
    const store = createStorage(base);
    await seed(store);
    const keys = (await store.list()).items.map((item) => item.key);
    expect(keys.some((key) => key.startsWith(".uploads-meta/"))).toBe(false);
    expect(keys).not.toContain("README.md");
  });

  it("paginates with a cursor", async () => {
    const store = createStorage(base);
    await seed(store);
    const first = await store.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBeDefined();
    const second = await store.list({ limit: 2, cursor: first.cursor });
    expect(second.items).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
  });
});

describe("delete and copy", () => {
  it("removes the object and its sidecar, and is idempotent", async () => {
    const store = createStorage(base);
    await store.upload("gone.txt", "bye");
    await store.delete("gone.txt");
    expect(api.blobs.has("gone.txt")).toBe(false);
    expect(api.blobs.has(".uploads-meta/gone.txt.json")).toBe(false);
    await expect(store.delete("gone.txt")).resolves.toBeUndefined();
  });

  it("copies the bytes and carries the metadata across", async () => {
    const store = createStorage(base);
    await store.upload("from.png", new Uint8Array([7, 8]), {
      contentType: "image/png",
      metadata: { origin: "test" },
    });
    await store.copy("from.png", "to.png");
    const copied = await store.head("to.png");
    expect(copied.metadata).toEqual({ origin: "test" });
    expect([...new Uint8Array(await copied.arrayBuffer())]).toEqual([7, 8]);
  });
});

describe("signedUploadUrl", () => {
  it("refuses, because GitHub has no presigned-upload primitive", async () => {
    const store = createStorage(base);
    await expect(store.signedUploadUrl("x.png", { expiresIn: 60 })).rejects.toThrow(
      /no presigned-upload primitive/,
    );
  });
});
