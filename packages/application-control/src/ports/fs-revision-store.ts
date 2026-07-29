import type { FsRevision } from "@everdict/contracts";

// The workspace filesystem's publication ledger — one append-only row per published revision of a file, holding
// the audit facts the bytes themselves cannot carry: WHO published it (member or agent, and for whom), WHEN, on
// top of which revision, and why. Retention is unlimited by product decision: a revision is never pruned.
//
// This store also OWNS revision allocation. `append` must be atomic on (tenant, path, revision) — a duplicate is
// a lost race and MUST throw ConflictError rather than overwrite, because that constraint is the only thing
// standing between two simultaneous writers and a silently clobbered edit. Implementations: PgFsRevisionStore
// (unique primary key does the work) and InMemoryFsRevisionStore (dev/test) — both in @everdict/db.
export interface FsRevisionStore {
  // Publish a revision. Throws ConflictError when (tenant, path, revision) already exists.
  append(record: FsRevision): Promise<void>;
  // The file's current revision — undefined when nothing was ever published at the path.
  head(tenant: string, path: string): Promise<FsRevision | undefined>;
  // Newest first. `limit` caps the page (implementations default to a sane page size).
  list(tenant: string, path: string, opts?: { limit?: number }): Promise<FsRevision[]>;
  get(tenant: string, path: string, revision: number): Promise<FsRevision | undefined>;
  // Carry a file's (or a whole subtree's) history along with a move, so "who published this" survives a rename.
  rename(tenant: string, from: string, to: string): Promise<void>;
  // How much the workspace's history costs — revision count + total bytes. Answered from the ledger's own `size`
  // column (one aggregate), never by walking object storage, so the Settings usage read stays cheap.
  usage(tenant: string): Promise<{ revisions: number; bytes: number }>;
  // Drop a workspace's entire history. The ONE caller is the danger-zone "empty the filesystem" action: once no
  // file references it, retained history is a surprise and a storage leak. Ordinary deletes keep their history.
  purge(tenant: string): Promise<number>;
}
