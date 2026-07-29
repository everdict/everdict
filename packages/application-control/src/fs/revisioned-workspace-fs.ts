import { createHash } from "node:crypto";
import {
  ConflictError,
  FS_SYSTEM_ACTOR,
  type FsActor,
  type FsEntry,
  type FsRevision,
  guessFsContentType,
} from "@everdict/contracts";
import type { FsRevisionStore } from "../ports/fs-revision-store.js";
import type { FsFile, FsWriteOptions, WorkspaceFs } from "../ports/workspace-fs.js";

// The workspace filesystem, versioned — a WorkspaceFs that publishes a REVISION on every write and refuses a
// write that lost a race. It decorates any underlying filesystem, so versioning is a single composition-root
// decision rather than something each caller has to remember: the web editor, the agent's `write_file`, the
// skill/knowledge content projections and the shell all publish through the same path and land in the same
// ledger. Nothing else in the codebase needs to know revisions exist.
//
// Ordering per write — blob, then ledger, then the visible file:
//   1. write the immutable revision blob (orphaned harmlessly if a later step fails),
//   2. append the ledger row, whose (tenant, path, revision) uniqueness is what ACTUALLY allocates the number,
//   3. overwrite the head object only once the revision is durably claimed.
// So a crash can leave an unreferenced blob or a revision the head hasn't caught up to, but never a published
// file whose authorship went unrecorded — the audit trail is the invariant we protect.
export class RevisionedWorkspaceFs implements WorkspaceFs {
  constructor(
    private readonly inner: WorkspaceFs,
    private readonly revisions: FsRevisionStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(tenant: string, dir: string): Promise<FsEntry[]> {
    return this.inner.list(tenant, dir); // deliberately un-enriched: a revision lookup PER ROW is not worth it
  }

  async stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    const entry = await this.inner.stat(tenant, path);
    if (!entry || entry.kind !== "file") return entry;
    return this.withRevision(tenant, entry);
  }

  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const file = await this.inner.read(tenant, path);
    if (!file) return undefined;
    return { ...file, entry: await this.withRevision(tenant, file.entry) };
  }

  // Publish a new revision of `path`. With `opts.baseRevision` this is an optimistic write: it succeeds only if
  // that is still the published head, and otherwise throws ConflictError carrying the head — the caller (FsService)
  // turns that into a three-way merge offer. Without it, the write is a blind overwrite that still publishes.
  async write(
    tenant: string,
    path: string,
    data: Uint8Array,
    contentType?: string,
    opts?: FsWriteOptions,
  ): Promise<FsEntry> {
    const type = contentType ?? guessFsContentType(path);
    const hash = createHash("sha256").update(data).digest("hex");
    const declaredBase = opts?.baseRevision;

    // Retry only covers losing the allocation race on a BLIND write; a write that declared its base must fail
    // loudly instead, because someone publishing underneath it is exactly the situation the caller asked about.
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await this.revisions.head(tenant, path);
      const current = head?.revision ?? 0;
      if (declaredBase !== undefined && declaredBase !== current) {
        throw new ConflictError(
          "CONFLICT",
          { path, baseRevision: declaredBase, headRevision: current },
          `'${path}' moved on to revision ${current} while you were editing revision ${declaredBase}`,
        );
      }
      const revision = current + 1;
      await this.inner.writeRevisionBlob(tenant, path, revision, data, type);
      const record: FsRevision = {
        tenant,
        path,
        revision,
        size: data.byteLength,
        contentType: type,
        hash,
        actor: opts?.actor ?? FS_SYSTEM_ACTOR,
        ...(opts?.message !== undefined ? { message: opts.message } : {}),
        ...(opts?.restoredFrom !== undefined ? { restoredFrom: opts.restoredFrom } : {}),
        createdAt: this.now(),
      };
      try {
        await this.revisions.append(record);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        if (declaredBase !== undefined) {
          throw new ConflictError(
            "CONFLICT",
            { path, baseRevision: declaredBase, headRevision: revision },
            `'${path}' moved on to revision ${revision} while you were editing revision ${declaredBase}`,
          );
        }
        continue; // a blind writer simply takes the next number
      }
      const entry = await this.inner.write(tenant, path, data, type, opts);
      return { ...entry, revision };
    }
    throw new ConflictError("CONFLICT", { path }, `'${path}' is being written too fast to publish a revision`);
  }

  mkdir(tenant: string, path: string): Promise<FsEntry> {
    return this.inner.mkdir(tenant, path);
  }

  // A removed file keeps its history (retention is unlimited): re-creating the path continues the same numbering,
  // so "who deleted this and what did it say" stays answerable and the old bytes stay restorable.
  remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number> {
    return this.inner.remove(tenant, path, opts);
  }

  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    const entry = await this.inner.move(tenant, from, to);
    await this.revisions.rename(tenant, from, to); // history follows the file — a rename is not a new file
    return entry;
  }

  writeRevisionBlob(
    tenant: string,
    path: string,
    revision: number,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    return this.inner.writeRevisionBlob(tenant, path, revision, data, contentType);
  }

  readRevisionBlob(tenant: string, path: string, revision: number): Promise<FsFile | undefined> {
    return this.inner.readRevisionBlob(tenant, path, revision);
  }

  removeRevisionBlobs(tenant: string): Promise<number> {
    return this.inner.removeRevisionBlobs(tenant);
  }

  private async withRevision(tenant: string, entry: FsEntry): Promise<FsEntry> {
    const head = await this.revisions.head(tenant, entry.path);
    return head ? { ...entry, revision: head.revision } : entry;
  }
}

// Actor of a member's own edit — the common case, and the shape the API builds from the authenticated principal.
export function memberActor(subject: string): FsActor {
  return { kind: "member", subject };
}
