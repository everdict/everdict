import type { FsActor, FsEntry } from "@everdict/contracts";

// A file read back from the workspace filesystem — the entry plus its bytes.
export interface FsFile {
  entry: FsEntry;
  data: Uint8Array;
}

// What a writer declares about a write beyond the bytes. All optional so the plain `write(tenant, path, data)`
// call sites (projections, backfills) keep compiling — a write with no actor is recorded as a system publish.
// `baseRevision` is the OPTIMISTIC LOCK: state the revision you edited and the write is refused (ConflictError)
// if anything was published since. Omit it and the write is a blind overwrite that still publishes a revision.
export interface FsWriteOptions {
  actor?: FsActor;
  baseRevision?: number; // 0 = "I expect to create this file"
  message?: string;
  restoredFrom?: number; // this write re-publishes that revision's bytes (set by the restore use-case)
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
//
// Revision content (`writeRevisionBlob`/`readRevisionBlob`) is the immutable per-revision copy behind the
// publication history. It lives in a namespace the ADAPTER owns and the visible tree can never see (S3: the
// tenant's sibling revision bucket) — so list/stat/move never have to filter a reserved path out of themselves.
// Callers address a blob by (path, revision); the ledger saying which revisions exist is the FsRevisionStore.
// RevisionedWorkspaceFs composes the two into the versioned filesystem every surface actually uses.
export interface WorkspaceFs {
  list(tenant: string, dir: string): Promise<FsEntry[]>;
  stat(tenant: string, path: string): Promise<FsEntry | undefined>;
  read(tenant: string, path: string): Promise<FsFile | undefined>;
  write(tenant: string, path: string, data: Uint8Array, contentType?: string, opts?: FsWriteOptions): Promise<FsEntry>;
  mkdir(tenant: string, path: string): Promise<FsEntry>;
  remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number>;
  move(tenant: string, from: string, to: string): Promise<FsEntry>;
  writeRevisionBlob(
    tenant: string,
    path: string,
    revision: number,
    data: Uint8Array,
    contentType: string,
  ): Promise<void>;
  readRevisionBlob(tenant: string, path: string, revision: number): Promise<FsFile | undefined>;
}
