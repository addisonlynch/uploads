/**
 * The API-side wiring for the `github-branch` provider: a workspace record carrying a
 * `github` block must survive `storageConfig` and produce a working store.
 *
 * This is the seam the provider adds to `apps/api` — everything above it (routes, auth,
 * files-core) is unchanged and already covered. The live half is skipped unless
 * `GH_LIVE_REPO` and `GH_TOKEN` are set, so the suite stays secret-free:
 *
 *   GH_LIVE_REPO=<owner>/<repo> GH_TOKEN=$(gh auth token) \
 *     pnpm --filter @uploads/api test github-branch-workspace
 */

import { afterAll, describe, expect, it } from "vitest";
import { storageConfig } from "../src/storage";
import { createStorage } from "@uploads/storage";
import type { WorkspaceRecord } from "../src/workspace";

const slug = process.env.GH_LIVE_REPO ?? "";
const token = process.env.GH_TOKEN ?? "";
const [owner, repo, ...rest] = slug.split("/");
const live = Boolean(owner && repo && rest.length === 0 && token);

const branch = `uploads-api-wiring-${Date.now()}`;

function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    provider: "github-branch",
    github: { owner: owner || "acme", repo: repo || "widgets", branch, token: token || "t0ken" },
    ...overrides,
  } as WorkspaceRecord;
}

// storageConfig reads secrets off env for the r2 path; github-branch needs none of them.
const env = {} as Env;

describe("github-branch workspace records", () => {
  it("carries the github block through storageConfig", async () => {
    const config = await storageConfig(env, workspace());
    expect(config.provider).toBe("github-branch");
    expect(config.github?.repo).toBe(repo || "widgets");
  });

  it("needs no bucket, binding or R2 credentials", async () => {
    // The whole point of the provider: objects live in a repo, so none of the bucket-shaped
    // fields apply. A record without them must still resolve.
    const config = await storageConfig(env, workspace());
    expect(config.bucket).toBeUndefined();
    expect(config.r2Binding).toBeUndefined();
    expect(config.accessKeyId).toBeUndefined();
    expect(createStorage(config).adapter.name).toBe("github-branch");
  });

  it("applies the workspace prefix like any other provider", async () => {
    const config = await storageConfig(env, workspace({ prefix: "berkshire/" }));
    expect(createStorage(config).prefix).toBe("berkshire");
  });
});

describe.skipIf(!live)("against the real GitHub API", { timeout: 60_000 }, () => {
  afterAll(async () => {
    await fetch(`https://api.github.com/repos/${slug}/git/refs/heads/${branch}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
  });

  it("stores and reads back through a workspace record, prefix included", async () => {
    // End to end for the wiring: workspace record -> storageConfig -> createStorage ->
    // adapter -> GitHub, with the same options apps/api/src/files-core.ts sends.
    const store = createStorage(await storageConfig(env, workspace({ prefix: "berkshire/" })));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 250, 255]);
    await store.upload("screenshots/pr-1/after.png", png, {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { uploadedAt: String(Date.now()), state: "after" },
    });

    const head = await store.head("screenshots/pr-1/after.png");
    expect(head.type).toBe("image/png");
    expect(head.metadata?.state).toBe("after");

    // The prefix must confine the object AND its metadata sidecar.
    const raw = await fetch(
      `https://api.github.com/repos/${slug}/git/trees/${branch}?recursive=1`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
    const paths = ((await raw.json()) as { tree: { path: string }[] }).tree.map((e) => e.path);
    expect(paths).toContain("berkshire/screenshots/pr-1/after.png");
    expect(paths).toContain("berkshire/screenshots/pr-1/after.png.uploads-meta.json");

    const url = await store.url("screenshots/pr-1/after.png");
    expect((await fetch(url)).status).toBe(404); // private repo: anonymous cannot read it
    console.log(`\n  embed:  <img src="${url}" width="450">\n`);
  });
});
