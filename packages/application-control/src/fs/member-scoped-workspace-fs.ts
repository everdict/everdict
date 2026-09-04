import { type FsEntry, MEMBER_MEMORY_ROOT, NotFoundError, memberMemoryOwnerOf } from "@everdict/contracts";
import type { FsFile, FsWriteOptions, WorkspaceFs } from "../ports/workspace-fs.js";

// One member's view of the workspace filesystem. Everything outside `memory/members/` passes through untouched —
// a workspace is one shared tree and that is the point of it. Inside, only the viewer's own subtree exists.
//
// This is a PORT decorator rather than a check in each FsService method, for the same reason the revision ledger
// and the memory secret guard are: every read the service performs — list, stat, read, and therefore search,
// usage and clear, which are built out of them — reaches storage through this object, so a method added tomorrow
// is scoped without anyone remembering to scope it. A per-call-site check is a hole waiting for the next call
// site, and `search_files` grepping another member's memory would be exactly that hole.
//
// Absence is spelled NOT FOUND, never FORBIDDEN: "you may not read this" still confirms the file exists, and what
// a member wrote privately includes the fact that they wrote it. Same rule every private read follows.
export class MemberScopedWorkspaceFs implements WorkspaceFs {
  // `viewer` undefined = a caller who is nobody in particular (a scheduled agent, an internal job): it sees the
  // shared tree and NO member area. Fail-safe by construction — forgetting to pass an identity hides memory
  // rather than exposing it.
  constructor(
    private readonly inner: WorkspaceFs,
    private readonly viewer?: string,
  ) {}

  private mine(path: string): boolean {
    const owner = memberMemoryOwnerOf(path);
    return owner === undefined || owner === this.viewer;
  }

  private require(path: string): void {
    if (!this.mine(path)) throw new NotFoundError("NOT_FOUND", { path }, `'${path}' does not exist`);
  }

  async list(tenant: string, dir: string): Promise<FsEntry[]> {
    const entries = await this.inner.list(tenant, dir);
    // Listing `memory/members` itself yields one directory per member — that listing IS the leak, so it is the
    // one place a name (not just a body) has to be filtered.
    return entries.filter((e) => this.mine(e.path));
  }

  async stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    return this.mine(path) ? this.inner.stat(tenant, path) : undefined;
  }

  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    return this.mine(path) ? this.inner.read(tenant, path) : undefined;
  }

  // async, not a bare throw: a Promise-returning method that throws synchronously escapes the caller's
  // .catch()/await-rejection path, so the refusal would surface as an uncaught error instead of a 404.
  async write(
    tenant: string,
    path: string,
    data: Uint8Array,
    contentType?: string,
    opts?: FsWriteOptions,
  ): Promise<FsEntry> {
    this.require(path);
    return this.inner.write(tenant, path, data, contentType, opts);
  }

  async mkdir(tenant: string, path: string): Promise<FsEntry> {
    this.require(path);
    return this.inner.mkdir(tenant, path);
  }

  async remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number> {
    this.require(path);
    // A recursive remove of a directory ABOVE the member areas (memory/, or the root) would delete every member's
    // memory through a path the viewer is allowed to name. Refuse rather than silently over-delete.
    if (opts?.recursive === true && coversMemberAreas(path)) {
      throw new NotFoundError("NOT_FOUND", { path }, `'${path}' does not exist`);
    }
    return this.inner.remove(tenant, path, opts);
  }

  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    this.require(from);
    this.require(to);
    return this.inner.move(tenant, from, to);
  }

  async writeRevisionBlob(
    tenant: string,
    path: string,
    revision: number,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    this.require(path);
    return this.inner.writeRevisionBlob(tenant, path, revision, data, contentType);
  }

  async readRevisionBlob(tenant: string, path: string, revision: number): Promise<FsFile | undefined> {
    return this.mine(path) ? this.inner.readRevisionBlob(tenant, path, revision) : undefined;
  }

  removeRevisionBlobs(tenant: string): Promise<number> {
    return this.inner.removeRevisionBlobs(tenant); // tenant-wide purge — an operator path, never a member's
  }
}

// Does removing this path recursively reach into member areas? True for the member root, its ancestors, and the
// tree root (spelled "" or "/").
function coversMemberAreas(path: string): boolean {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "") return true;
  return `${MEMBER_MEMORY_ROOT}/`.startsWith(`${normalized}/`);
}
