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
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { FsFile, FsWriteOptions, WorkspaceFs } from "../ports/workspace-fs.js";
import { assertNoSecretsInMemory, isMemoryPath } from "./memory-secret-guard.js";

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
    // E2 (event-plumbing.md §3): a publish is a state transition, so it emits its fact — file.published rides
    // the same choke point as the revision itself. Absent = ledger-only (tests, minimal wirings).
    private readonly events?: PlatformEventEmitter,
  ) {}

  list(tenant: string, dir: string): Promise<FsEntry[]> {
    return this.inner.list(tenant, dir); // deliberately un-enriched: a revision lookup PER ROW is not worth it
  }

  async stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    const entry = await this.inner.stat(tenant, path);
    if (!entry || entry.kind !== "file") return entry;
    return this.withRevision(tenant, entry);
  }

  // Reads REPAIR the one inconsistency this ordering can leave behind. The write sequence is blob → ledger → head
  // object; if the process dies between steps 2 and 3, the revision is published but the visible file still holds
  // the previous bytes — a reader would see stale content labelled with the new revision, which is worse than
  // either half alone. So a read compares the live object against the head revision's recorded SIZE and, on a
  // mismatch, serves the published bytes and writes them back to the head.
  //
  // Size, not hash: it costs nothing (both numbers are already in hand) and catches the realistic failure — a
  // partial write of DIFFERENT content. Two revisions that differ while sharing a byte count slip through, and
  // that is the accepted limit; the alternative is hashing every read forever to cover a crash window.
  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const file = await this.inner.read(tenant, path);
    if (!file) return undefined;
    const head = await this.revisions.head(tenant, path);
    if (!head) return file;
    if (head.size === file.data.byteLength) {
      return { ...file, entry: { ...file.entry, revision: head.revision } };
    }
    const published = await this.inner.readRevisionBlob(tenant, path, head.revision);
    if (!published) return { ...file, entry: { ...file.entry, revision: head.revision } };
    // Best-effort repair: the read must still succeed if the write-back fails (storage down, permissions).
    await this.inner.write(tenant, path, published.data, head.contentType).catch(() => undefined);
    return { ...published, entry: { ...published.entry, revision: head.revision } };
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
    // Credentials never enter memory/ — checked here, on the bytes, because this decorator is what EVERY writer
    // goes through (see the composition note above). A per-service check would miss the next service.
    assertNoSecretsInMemory(path, data);
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
      // The publish fact — emitted only once the revision is durably claimed AND the head caught up. An
      // agent-authored publish stamps causedBy with the loop guard's key, so an agent watching a folder
      // never wakes on its own writes.
      const actor = record.actor;
      const actorName = actor.kind === "agent" ? (actor.onBehalfOf ?? actor.subject) : actor.subject;
      void this.events?.emit({
        workspace: tenant,
        kind: "file.published",
        subject: { type: "file", id: path },
        ...(actorName !== "" ? { actor: actorName } : {}),
        ...(actor.kind === "agent" && actor.agentId !== undefined && actor.conversationId !== undefined
          ? { causedBy: `agent:${actor.agentId}:${actor.conversationId}` }
          : {}),
        payload: {
          path,
          revision,
          size: data.byteLength,
          contentType: type,
          actorKind: actor.kind,
          ...(actor.agentId !== undefined ? { agentId: actor.agentId } : {}),
        },
        message: `${path} published as revision ${revision}`,
      });
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

  // Moving a file INTO memory/ publishes its content to memory just as surely as writing it there, so it faces the
  // same guard — the one round trip is worth it because this was the way around a write-only check.
  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    if (isMemoryPath(to) && !isMemoryPath(from)) {
      const file = await this.inner.read(tenant, from);
      if (file) assertNoSecretsInMemory(to, file.data);
    }
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
