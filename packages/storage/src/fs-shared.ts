import { BadRequestError, type FsEntry } from "@everdict/contracts";

// Guards + shaping shared by the WorkspaceFs implementations (InMemory + S3). The tenant is part of the storage
// key, so it gets the same strict charset as a path segment — a workspace id can never smuggle a separator.
const FS_TENANT_RE = /^[A-Za-z0-9._-]+$/;

export function assertFsTenant(tenant: string): string {
  if (!FS_TENANT_RE.test(tenant)) {
    throw new BadRequestError("BAD_REQUEST", { tenant }, "invalid workspace id for filesystem access");
  }
  return tenant;
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
