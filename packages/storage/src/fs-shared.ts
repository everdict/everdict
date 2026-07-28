import { createHash } from "node:crypto";
import { BadRequestError, type FsEntry } from "@everdict/contracts";

// Guards + shaping shared by the WorkspaceFs implementations (InMemory + S3). The tenant selects the storage
// namespace (its own BUCKET on S3), so it gets the same strict charset as a path segment — a workspace id can
// never smuggle a separator.
const FS_TENANT_RE = /^[A-Za-z0-9._-]+$/;

export function assertFsTenant(tenant: string): string {
  if (!FS_TENANT_RE.test(tenant)) {
    throw new BadRequestError("BAD_REQUEST", { tenant }, "invalid workspace id for filesystem access");
  }
  return tenant;
}

// The operator-chosen bucket-name prefix must itself be bucket-legal (it heads every tenant bucket).
const FS_BUCKET_PREFIX_RE = /^[a-z0-9][a-z0-9-]*$/;

export function assertFsBucketPrefix(prefix: string): string {
  if (!FS_BUCKET_PREFIX_RE.test(prefix) || prefix.length > 32) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { prefix },
      "bucket prefix must be lowercase letters/digits/hyphens (max 32 chars)",
    );
  }
  return prefix;
}

// One S3/MinIO BUCKET per tenant — the isolation boundary IS the bucket (per-tenant credentials, quotas and
// lifecycle policies become possible at the storage layer), not merely a key prefix inside a shared one.
// Bucket names are constrained (3–63 chars, lowercase letters/digits/hyphens, alphanumeric ends) while tenant
// slugs are not ([A-Za-z0-9._-], case-sensitive), so the name is `<prefix>-<sanitized>-<hash8>`: the sanitized
// slug keeps it operator-readable, and the sha256 tail guarantees DISTINCT tenants never collide onto one
// bucket ("Acme" vs "acme", "a.b" vs "a-b" — a sanitization collision would be cross-tenant leakage).
export function fsBucketFor(prefix: string, tenant: string): string {
  const slug = assertFsTenant(tenant);
  const hash = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const head = `${assertFsBucketPrefix(prefix)}-${sanitized}`.slice(0, 63 - 9).replace(/-+$/, "");
  return `${head}-${hash}`;
}

export function fsEntryName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export const FS_ROOT_ENTRY: FsEntry = { path: "", name: "", kind: "dir" };

// Listing order: directories first, then files, each name-sorted — the fixed order every surface renders.
export function sortFsEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

export function fsAncestors(path: string): string[] {
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(segments.slice(0, i).join("/"));
  return out;
}
