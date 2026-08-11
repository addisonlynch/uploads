import { Files } from "files-sdk";
export { createFilesRouter } from "files-sdk/api";
import { r2 } from "files-sdk/r2";
import { githubBranch, githubBranchUrl, type GithubBranchConfig } from "./github-branch";

export { githubBranch, githubBranchUrl };
export type { GithubBranchConfig };

/**
 * Provider-agnostic storage config. `provider` selects the files-sdk adapter;
 * everything else is the superset of fields the supported adapters need.
 * Adding a provider = add a case in `createStorage` plus its peer deps.
 */
export type StorageProvider = "r2" | "github-branch";

/** R2 jurisdictions with dedicated S3 endpoints (Cloudflare: eu = European Union, fedramp = FedRAMP). */
export const R2_JURISDICTIONS = ["eu", "fedramp"] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

/** Type guard for {@link R2Jurisdiction} — use on untrusted strings before they reach `StorageConfig`. */
export function isR2Jurisdiction(value: string): value is R2Jurisdiction {
  return (R2_JURISDICTIONS as readonly string[]).includes(value);
}

export interface StorageConfig {
  provider: StorageProvider;
  /** Bucket name. Required by the bucket-backed providers; unused by `github-branch`. */
  bucket?: string;
  /** Public base URL for objects served off a custom domain (e.g. https://media.example.com). */
  publicBaseUrl?: string;
  /** R2: Workers binding. When set, reads/writes go through the binding (no egress). */
  r2Binding?: R2Bucket;
  /** S3-style HTTP credentials — required for url()/signedUploadUrl(), optional otherwise when a binding exists. */
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * R2 jurisdiction the bucket was created in. Jurisdiction buckets are only
   * reachable at `https://<accountId>.<jurisdiction>.r2.cloudflarestorage.com`,
   * so this switches the S3 endpoint used for HTTP I/O and hybrid-mode
   * signing. Ignored only in pure binding mode (no HTTP credentials), where
   * the wrangler binding declaration carries the jurisdiction and nothing
   * ever touches the S3 endpoint.
   */
  jurisdiction?: R2Jurisdiction;
  /**
   * Key prefix all operations are confined under (e.g. "myws/"). Must end
   * with "/". Applied via files-sdk's instance prefix; clients never see it.
   */
  prefix?: string;
  /**
   * github-branch: the repository and orphan branch that hold the objects, plus a token
   * with `contents: write` on it. Set instead of `bucket`/credentials — this provider
   * stores in the customer's own repo so the bytes inherit that repo's access control.
   */
  github?: GithubBranchConfig;
}

/** Segments of lowercase alphanumerics/._- each ending in "/"; first char alphanumeric (so "." and ".." are impossible). */
const PREFIX_RE = /^([a-z0-9][a-z0-9._-]*\/)+$/;

export function createStorage(config: StorageConfig): Files {
  if (config.prefix !== undefined && !PREFIX_RE.test(config.prefix)) {
    throw new Error(`invalid storage prefix: ${JSON.stringify(config.prefix)}`);
  }
  switch (config.provider) {
    case "r2": {
      if (!config.bucket) throw new Error("r2 storage requires a `bucket`");
      const shared = {
        accountId: config.accountId,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        publicBaseUrl: config.publicBaseUrl,
        // Jurisdiction switches the S3 endpoint for HTTP I/O and hybrid-mode
        // signing alike; pure binding mode (no HTTP creds) never builds an S3
        // client, so the extra option is inert there.
        ...(config.jurisdiction && {
          endpoint: `https://${config.accountId}.${config.jurisdiction}.r2.cloudflarestorage.com`,
        }),
      };
      // Binding mode (hybrid when HTTP creds are also set) vs pure HTTP mode.
      const bucket = config.bucket;
      const adapter = config.r2Binding
        ? r2({ binding: config.r2Binding, bucket, ...shared })
        : r2({ bucket, ...shared });
      return new Files({ adapter, prefix: config.prefix });
    }
    case "github-branch": {
      if (!config.github) {
        throw new Error("github-branch storage requires a `github` config block");
      }
      return new Files({ adapter: githubBranch(config.github), prefix: config.prefix });
    }
    default:
      throw new Error(`Unsupported storage provider: ${config.provider satisfies never}`);
  }
}

/**
 * Stable public URL for a key, or null when the provider has no way to build one. Includes
 * the workspace prefix. For bucket providers that means a configured custom domain; for
 * `github-branch` the URL is always available, since it is the repo's own blob URL.
 */
export function publicUrl(config: StorageConfig, key: string): string | null {
  // github-branch builds its own: the `?raw=true` query cannot be expressed by the
  // `base + "/" + key` shape below.
  if (config.provider === "github-branch") {
    if (!config.github) return null;
    return githubBranchUrl(config.github, `${config.prefix ?? ""}${key}`);
  }
  if (!config.publicBaseUrl) return null;
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const fullKey = `${config.prefix ?? ""}${key}`;
  return `${base}/${fullKey.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Embed twin for the shared bucket (`embed.uploads.sh`): same keys as the
 * durable storage host, badge-style Cache-Control via zone Transform Rule so
 * GitHub Camo revalidates after in-place overwrites.
 */
export const DEFAULT_EMBED_PUBLIC_BASE_URL = "https://embed.uploads.sh";

/** Hosts that get an automatic embed twin when no override is set. */
const DEFAULT_EMBEDDABLE_HOSTS = new Set(["storage.uploads.sh", "store.uploads.sh"]);

export type EmbedUrlOptions = {
  /**
   * Embed CDN base.
   * - omit → default twin when `publicBaseUrl` host is embeddable
   * - empty string → disable
   * - URL → self-hosted override
   */
  embedBaseUrl?: string | null;
};

/** Resolve embed CDN base for a workspace public base (or disable / override). */
export function resolveEmbedBaseUrl(
  publicBaseUrl?: string | null,
  embedBaseUrl?: string | null,
): string | null {
  if (embedBaseUrl != null) {
    const trimmed = embedBaseUrl.trim();
    return trimmed ? trimmed.replace(/\/$/, "") : null;
  }
  if (!publicBaseUrl) return null;
  try {
    const host = new URL(publicBaseUrl).hostname.toLowerCase();
    if (DEFAULT_EMBEDDABLE_HOSTS.has(host)) return DEFAULT_EMBED_PUBLIC_BASE_URL;
  } catch {
    return null;
  }
  return null;
}

/**
 * Map a stable public object URL to the embed twin.
 * When `publicBaseUrl` is omitted, infers it from known embeddable hosts on the URL.
 */
export function embedUrlFromPublic(
  publicObjectUrl: string | null | undefined,
  opts: EmbedUrlOptions & { publicBaseUrl?: string | null } = {},
): string | null {
  if (!publicObjectUrl) return null;

  let publicBaseUrl = opts.publicBaseUrl ?? null;
  if (!publicBaseUrl) {
    try {
      const u = new URL(publicObjectUrl);
      if (DEFAULT_EMBEDDABLE_HOSTS.has(u.hostname.toLowerCase())) {
        publicBaseUrl = `${u.protocol}//${u.host}`;
      }
    } catch {
      return null;
    }
  }

  const embedBase = resolveEmbedBaseUrl(publicBaseUrl, opts.embedBaseUrl);
  if (!embedBase || !publicBaseUrl) return null;
  const stableBase = publicBaseUrl.replace(/\/$/, "");
  if (publicObjectUrl === stableBase || publicObjectUrl.startsWith(`${stableBase}/`)) {
    return `${embedBase}${publicObjectUrl.slice(stableBase.length)}`;
  }
  return null;
}

/** Stable + embed public URLs for a key (either may be null). */
export function publicAndEmbedUrls(
  config: StorageConfig,
  key: string,
  opts?: EmbedUrlOptions,
): { url: string | null; embedUrl: string | null } {
  const url = publicUrl(config, key);
  // Same-origin URLs never pass through Camo, so there is no twin to revalidate against:
  // the stable URL is already the embed URL.
  if (config.provider === "github-branch") return { url, embedUrl: url };
  return {
    url,
    embedUrl: embedUrlFromPublic(url, {
      publicBaseUrl: config.publicBaseUrl,
      embedBaseUrl: opts?.embedBaseUrl,
    }),
  };
}

/** Options for {@link signedDownloadUrl}. */
export interface SignedDownloadUrlOptions {
  /** How long the URL stays valid, in seconds. Defaults to 3600 (files-sdk's own default). */
  expiresIn?: number;
}

/**
 * Short-lived signed download URL for `key`, or `null` when the adapter has
 * no signing primitive to mint one — e.g. an R2 binding with neither
 * `publicBaseUrl` nor HTTP credentials (`accountId`/`accessKeyId`/`secretAccessKey`).
 * Mirrors {@link Files.signedUploadUrl}'s presigning, but for reads: it forces
 * `responseContentDisposition: "attachment"` so a user-uploaded HTML/SVG never
 * renders inline at the bucket's origin (stored XSS).
 *
 * Checks {@link Files.capabilities}' `signedUrl.supported` flag up front so
 * callers get a clean `null` instead of a thrown provider error when signing
 * isn't possible. Callers should try {@link publicUrl} first — a workspace
 * with `publicBaseUrl` configured should get its stable custom-domain URL
 * instead of a short-lived signed one.
 */
export async function signedDownloadUrl(
  store: Files,
  key: string,
  opts: SignedDownloadUrlOptions = {},
): Promise<string | null> {
  if (!store.capabilities.signedUrl.supported) return null;
  return store.url(key, {
    expiresIn: opts.expiresIn ?? 3600,
    responseContentDisposition: "attachment",
  });
}

export type { Files };
