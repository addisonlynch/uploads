/**
 * Live proof for the `github-branch` provider, against the real GitHub API.
 *
 * Skipped unless both `GH_LIVE_REPO` (owner/repo) and `GH_TOKEN` are set, so `pnpm test` stays
 * secret-free the way CONTRIBUTING promises:
 *
 *   GH_LIVE_REPO=<owner>/<repo> GH_TOKEN=$(gh auth token) \
 *     pnpm --filter @uploads/storage test github-branch.live
 *
 * The token needs `contents: write` on that repo. Everything runs through `createStorage`, so
 * it exercises the same files-sdk wrapper `apps/api` uses — including the option gating that
 * rejects an adapter which does not advertise metadata/cacheControl support. The unit tests in
 * github-branch.test.ts cover the same surface over a fake; this is what proves the real API
 * behaves the way the fake claims.
 */

import { afterAll, describe, expect, it } from "vitest";
import { createStorage } from "../src/index.js";

const slug = process.env.GH_LIVE_REPO ?? "";
const token = process.env.GH_TOKEN ?? "";
const [owner, repo, ...rest] = slug.split("/");
const configured = Boolean(owner && repo && rest.length === 0 && token);

const branch = `github-branch-live-${Date.now()}`;
const bytes = (text: string) => new TextEncoder().encode(text);

// Each case is several GitHub round trips, and upload deliberately waits out the read-after-
// write lag, so the 5s default would time out on latency rather than on a defect.
describe.skipIf(!configured)(
  "github-branch against the real GitHub API",
  { timeout: 60_000 },
  () => {
    const store = createStorage({
      provider: "github-branch",
      github: { owner: owner!, repo: repo!, branch, token },
    });

    afterAll(async () => {
      await fetch(`https://api.github.com/repos/${slug}/git/refs/heads/${branch}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
    });

    it("uploads with the options the API always sends, creating the orphan branch", async () => {
      const payload = bytes("github-branch live proof\n");
      const result = await store.upload("demo/hello.txt", payload, {
        contentType: "text/plain",
        cacheControl: "public, max-age=60",
        metadata: { uploadedAt: String(Date.now()), state: "after" },
      });
      expect(result.size).toBe(payload.byteLength);
    });

    it("survives rapid overwrites of one stable key", async () => {
      // The read that supplies the blob sha lags the write that changed it, so this is the case
      // the real API fails without the replay.
      for (let index = 1; index <= 4; index += 1) {
        await store.upload("demo/hello.txt", bytes(`revision ${index}\n`));
      }
      expect(await (await store.download("demo/hello.txt")).text()).toBe("revision 4\n");
    });

    it("returns a key that is readable the moment upload resolves", async () => {
      // upload() waits out the read-after-write lag precisely so the URL it implies resolves.
      await store.upload("demo/fresh.txt", bytes("fresh\n"));
      expect(await store.exists("demo/fresh.txt")).toBe(true);
    });

    it("carries metadata and content type through the sidecar", async () => {
      // Its own key: an overwrite replaces metadata (as an S3 PUT does), so asserting this on a
      // key the overwrite case rewrites without options would be testing the wrong thing.
      await store.upload("demo/tagged.txt", bytes("tagged\n"), {
        contentType: "text/plain",
        metadata: { state: "after" },
      });
      const head = await store.head("demo/tagged.txt");
      expect(head.metadata?.state).toBe("after");
      expect(head.type).toBe("text/plain");
    });

    it("round-trips binary content exactly", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 250, 255]);
      await store.upload("demo/nested/tiny.png", png, { contentType: "image/png" });
      const back = new Uint8Array(
        await (await store.download("demo/nested/tiny.png")).arrayBuffer(),
      );
      expect([...back]).toEqual([...png]);
    });

    it("lists by string prefix, including nested keys, hiding sidecars", async () => {
      const keys = (await store.list({ prefix: "demo/" })).items.map((item) => item.key).sort();
      expect(keys).toContain("demo/nested/tiny.png");
      expect(keys.some((key) => key.startsWith(".uploads-meta/"))).toBe(false);
    });

    it("copies and deletes", async () => {
      await store.copy("demo/hello.txt", "demo/copied.txt");
      expect(await store.exists("demo/copied.txt")).toBe(true);
      await store.delete("demo/hello.txt");
      expect(await store.exists("demo/hello.txt")).toBe(false);
      await expect(store.delete("demo/hello.txt")).resolves.toBeUndefined();
    });

    it("produces a same-origin URL whose reachability follows the repo's own visibility", async () => {
      const url = await store.url("demo/nested/tiny.png");
      expect(url).toBe(`https://github.com/${slug}/blob/${branch}/demo/nested/tiny.png?raw=true`);

      // The whole point of the provider: the object inherits the repo's access control rather
      // than being world-readable on a CDN. On a private repo an anonymous fetch 404s; on a
      // public one it succeeds, and there is nothing to prove — so assert against the repo's
      // actual visibility rather than assuming which kind of repo the runner pointed us at.
      const meta = (await (
        await fetch(`https://api.github.com/repos/${slug}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        })
      ).json()) as { private: boolean };
      const anonymous = await fetch(url);
      expect(anonymous.status).toBe(meta.private ? 404 : 200);
      if (!meta.private) {
        console.log(`\n  note: ${slug} is public, so the privacy property is not exercised here\n`);
      }
      console.log(`\n  embed:  <img src="${url}" width="450">\n`);
    });
  },
);
