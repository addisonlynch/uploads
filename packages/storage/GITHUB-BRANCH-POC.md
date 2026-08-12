# `github-branch` storage provider — proof of concept

A files-sdk adapter that stores objects on an **orphan branch of the customer's own
repository**, addressed by a same-origin `github.com/<owner>/<repo>/blob/<branch>/<key>?raw=true`
URL.

Proposed as a fifth option for **#414 — private-repo attachment privacy (guessable `gh/` keys
on public CDN)**.

## Why

The four options on #414 all try to make a public origin behave privately: unguessable keys,
signed URLs, edge auth, or a policy that refuses a public base URL. This takes the other
route — put the bytes somewhere GitHub already authenticates, and let the repo's existing
access control be the access control.

A `github.com/.../blob/...?raw=true` URL is **same-origin**, so GitHub's renderer passes it
through un-proxied and the viewer's own session cookie fetches it. Repo members see the
image; everyone else gets a 404. No signing, no expiry, no edge auth, nothing to rotate.

That property is not reachable any other way. GitHub rewrites every non-GitHub image URL to
`camo.githubusercontent.com` and fetches it **server-side and anonymously**, so any external
origin — the shared bucket, a BYO bucket, anything — has to be publicly readable or it will
not render at all. Privacy on a CDN can only ever be obscurity; this is actual access control.

It is also the mechanism `reg-viz/reg-actions` ships, so it is proven in the wild rather than
novel.

## Try it

```bash
# unit tests — no network, no accounts
pnpm --filter @uploads/storage test

# the same surface against the real GitHub API
GH_LIVE_REPO=<owner>/<repo> GH_TOKEN=$(gh auth token) \
  pnpm --filter @uploads/storage test github-branch.live
```

The live test skips unless both variables are set, so `pnpm test` stays secret-free the way
CONTRIBUTING promises. It needs a token with `contents: write` on that repo — no bucket, no
credentials, no deploy. It creates a throwaway branch, drives the provider through the `Files`
wrapper exactly as `apps/api` does, prints an embeddable URL, and deletes the branch after.

The live test asserts the privacy property directly: it fetches the resulting URL
anonymously and requires a 404 on a private repo (and a 200 on a public one, where there is
nothing to prove). Verified against a private repo.

## What is here

| File                   |                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `src/github-branch.ts` | The adapter. Contents API + Git Data API, no git binary, Worker-compatible `fetch` only.   |
| `src/index.ts`         | `"github-branch"` added to `StorageProvider`, a case in `createStorage`, and URL handling. |

| `test/github-branch.test.ts` | Unit tests over a fake GitHub API — no network. |
| `test/fake-github.ts` | The fake. Reproduces sha conflicts, the invisible-repo 404, and read-after-write lag. |
| `test/github-branch.live.test.ts` | The live proof, skipped unless `GH_LIVE_REPO` + `GH_TOKEN` are set. |

`publicUrl` and `publicAndEmbedUrls` needed two small branches:

- The URL is built by the provider, because `?raw=true` is a query and the shared
  `base + "/" + key` shape cannot express it.
- There is no embed twin, and that is the point rather than a gap. The twin exists so Camo
  revalidates after an in-place overwrite; a same-origin URL never goes through Camo, so the
  stable URL is already the embed URL.

## Two things the API forces, both found by running it

**GitHub rejects an empty tree** (`422 Invalid tree info`), so the orphan branch cannot be
created bare. It is seeded with a README explaining what the branch is and that reclaiming
space means rotating it.

**The Contents API is read-after-write eventually consistent.** Measured: an object 404s on a
read immediately after its own upload, and `exists` returns true immediately after a
successful delete. The writes are correct — the git tree and commit log confirm it — the
_read_ is stale.

That lands on the hot path, because overwriting a stable key needs the current blob sha, and
that is exactly the read that goes stale. Rapid revisions of one key fail without handling.
So `upload`:

- retries on 409/422 by re-reading the sha (also covers a genuine concurrent writer), and
- waits until the object reads back before returning, so a URL is never handed to a caller
  before it resolves.

The demo covers both cases.

## Costs, honestly

- **Repo size.** Objects live in the git object store, so they count toward the repo and a
  full `git clone` fetches this branch with every other ref. Shallow and single-branch clones
  skip it, which covers CI and most day-to-day use. Native GitHub attachments live on a CDN
  and do not.
- **Retention means rotating the branch**, not expiring objects: an overwrite is a new commit
  and old blobs stay reachable by sha. `retentionDays` does not map onto git history. (This is
  the same bound GitHub's own attachments have.)
- **GitHub surfaces only.** It stores in a repo, so it cannot serve non-GitHub destinations.
- **Object size.** Capped at 20 MB. The Contents API takes base64 in a JSON body, so the
  request is ~1.33x the object and the encode plus the JSON copy is ~2.7x — the cap is checked
  before encoding so a large body cannot exhaust a Worker's 128 MB before the guard fires.
- **Request budget.** An upload costs up to ~10 subrequests (repo check, ref probe, read, PUT,
  the same for the sidecar, then visibility polls) against a 50-subrequest ceiling on Workers
  Free. Fine per upload; worth knowing before a bulk migration.

## Wiring: enough to run, not enough to ship

A workspace record can carry a `github: { owner, repo, branch, token }` block, `storageConfig`
passes it through, and `workspace:add --github-repo` seeds one. That is deliberately the
minimum needed to drive the provider as a running service (`wrangler dev --local`, real HTTP
upload, real repo) rather than only through a test harness.

The product decisions are **not** made here, and this wiring should not be read as proposing
them: where the token comes from (an App installation token is the obvious answer, not a
stored PAT), how this interacts with `byoBucketEnabled`, plan gating and `publicBaseUrl`, and
whether the destination belongs on the workspace at all rather than per-repo. The token is
stored as a plain field, unlike `accessKeyId`/`secretAccessKey`, which go through
`openCredentialFields` — that alone is reason not to ship this shape as-is.

Also not done: any change to the CLI, MCP or admin UI surfaces, and the `README.md` "Adding a provider"
checklist step that assumes a provider ships as a files-sdk peer dependency — this adapter is
in-repo instead, which is the one deliberate deviation from that checklist.

Two collisions are silent by construction and worth a decision before this ships: a user key
ending in `.uploads-meta.json` is hidden from `list()`, and one named `README.md` collides with
the branch seed.
