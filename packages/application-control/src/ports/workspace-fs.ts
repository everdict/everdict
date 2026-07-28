import type { FsEntry } from "@everdict/contracts";

// A file read back from the workspace filesystem — the entry plus its bytes.
export interface FsFile {
  entry: FsEntry;
  data: Uint8Array;
}

// The workspace filesystem port — a per-workspace-isolated file tree over object storage. Every method takes the
// tenant FIRST and the implementation maps it to an inescapable key prefix (isolation lives in the adapter, not in
// caller discipline; paths are normalized + traversal-rejected inside every operation). Directories are prefixes
// (mkdir writes an empty marker so empty dirs survive). Implementations: S3WorkspaceFs (S3/MinIO — the distributed
// backend), InMemoryWorkspaceFs (dev/test) — both in @everdict/storage.
//
// Semantics (bash-adjacent, kept deliberately small):
// - list: immediate children of a dir ("" = root), dirs first then files, name-sorted. Missing/empty dir → [].
// - stat: entry for a path — a file, an explicit dir (marker) or an implicit dir (some file lives under it).
// - read: file bytes, undefined when absent (a dir is not readable → BadRequestError).
// - write: create-or-replace a file; parents are implicit. Writing over a dir → ConflictError.
// - mkdir: idempotent (mkdir -p); a file at the path → ConflictError.
// - remove: returns the number of objects removed (0 = nothing there). A non-empty dir needs recursive:true,
//   else ConflictError.
// - move: rename a file or a whole dir subtree. Target occupied → ConflictError; moving a dir into itself →
//   BadRequestError; source missing → NotFoundError.
export interface WorkspaceFs {
  list(tenant: string, dir: string): Promise<FsEntry[]>;
  stat(tenant: string, path: string): Promise<FsEntry | undefined>;
  read(tenant: string, path: string): Promise<FsFile | undefined>;
  write(tenant: string, path: string, data: Uint8Array, contentType?: string): Promise<FsEntry>;
  mkdir(tenant: string, path: string): Promise<FsEntry>;
  remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number>;
  move(tenant: string, from: string, to: string): Promise<FsEntry>;
}
