import {
  BadRequestError,
  ConflictError,
  type FsActor,
  type FsEntry,
  type FsRevision,
  NotFoundError,
  guessFsContentType,
  isFsTextContentType,
} from "@everdict/contracts";
import type { FsWriteConflict } from "@everdict/contracts/wire";
import { mergeThreeWay } from "@everdict/domain";
import type { FsRevisionStore } from "../ports/fs-revision-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

export interface WriteFsFileInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64"; // default utf8; base64 for binary payloads
  contentType?: string; // default: guessed from the extension
  baseRevision?: number; // the revision the author edited — the optimistic lock (omit for a blind overwrite)
  message?: string; // why this revision was published
}

export interface FsFileContent {
  entry: FsEntry;
  content: string;
  encoding: "utf8" | "base64";
}

// Storage usage as the Settings surface reports it — counted through the SERVICE (never by touching object
// storage directly): totals + a per-top-level-entry breakdown so an operator sees where the bytes live
// (tasks/ · reports/ · skills/ · …). `truncated` = the walk stopped at the cap; counts are a floor.
export interface FsUsageTopLevel {
  path: string;
  name: string;
  kind: "file" | "dir";
  files: number;
  bytes: number;
}

export interface FsUsage {
  files: number;
  bytes: number;
  truncated: boolean;
  topLevel: FsUsageTopLevel[];
  // Published history's own footprint (revision blobs, which live outside the tree above) — absent when the
  // deployment has no revision ledger wired.
  history?: { revisions: number; bytes: number };
}

const USAGE_WALK_CAP = 20_000; // max entries visited per usage sweep — keeps a huge tree from stalling Settings

// The workspace-filesystem use-cases — response shaping over the WorkspaceFs port: text-vs-binary encoding on
// read, base64 decode on write, a read/remove miss mapped to 404. Path safety + tenant isolation live in the
// port implementations (every operation normalizes + prefix-scopes internally); this layer never re-derives them.
//
// Versioning: the injected `fs` is normally a RevisionedWorkspaceFs, so every write publishes a revision on its
// own. What this service adds on top is the COLLABORATION story — reading the history, restoring an old revision,
// and turning a lost race (the port's bare ConflictError) into an actionable merge offer. `revisions` is the
// ledger for the read side; without it the history surfaces are simply unavailable (dev without a store).
export class FsService {
  constructor(
    private readonly fs: WorkspaceFs,
    private readonly revisions?: FsRevisionStore,
  ) {}

  list(tenant: string, path?: string): Promise<FsEntry[]> {
    return this.fs.list(tenant, path ?? "");
  }

  stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    return this.fs.stat(tenant, path);
  }

  async readFile(tenant: string, path: string): Promise<FsFileContent> {
    const file = await this.fs.read(tenant, path);
    if (!file) throw new NotFoundError("NOT_FOUND", { path }, `'${path}' does not exist`);
    return shapeContent(file.entry, file.data);
  }

  // Publish a revision of a file. `actor` comes from the authenticated caller (never from the payload — authorship
  // is authority, not user input). A write that declared a `baseRevision` and lost the race comes back as a 409
  // whose data is the FULL resolution kit (live content + attempted three-way merge), so both resolvers — the web
  // merge dialog and an agent reading the tool error — can finish in one more round trip instead of re-reading.
  async writeFile(tenant: string, input: WriteFsFileInput, actor?: FsActor): Promise<FsEntry> {
    const data =
      input.encoding === "base64" ? decodeBase64(input.path, input.content) : new TextEncoder().encode(input.content);
    try {
      return await this.fs.write(tenant, input.path, data, input.contentType, {
        ...(actor !== undefined ? { actor } : {}),
        ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
    } catch (err) {
      if (!(err instanceof ConflictError) || input.baseRevision === undefined) throw err;
      throw new ConflictError(
        "CONFLICT",
        { ...(await this.resolutionKit(tenant, input)) },
        `${err.message}. Merge the published revision, then publish again.`,
      );
    }
  }

  // Everything a caller needs to reconcile a conflicted write, gathered on the failure path only.
  private async resolutionKit(tenant: string, input: WriteFsFileInput): Promise<FsWriteConflict> {
    const base = input.baseRevision ?? 0;
    const head = await this.fs.stat(tenant, input.path);
    const headRevision = head?.revision ?? 0;
    const kit: FsWriteConflict = { path: input.path, baseRevision: base, headRevision };
    const live = await this.readFile(tenant, input.path).catch(() => undefined);
    if (!live || live.entry.revision === undefined) return kit;
    const withHead: FsWriteConflict = {
      ...kit,
      head: { content: live.content, encoding: live.encoding, revision: live.entry.revision },
    };
    // A merge is only meaningful between three TEXTS: the incoming write, the live file, and the ancestor blob.
    if (input.encoding === "base64" || live.encoding !== "utf8" || base === 0) return withHead;
    const ancestor = await this.fs.readRevisionBlob(tenant, input.path, base);
    if (!ancestor) return withHead;
    let ancestorText: string;
    try {
      ancestorText = new TextDecoder("utf-8", { fatal: true }).decode(ancestor.data);
    } catch {
      return withHead; // the ancestor was binary — nothing to merge line by line
    }
    return { ...withHead, merge: mergeThreeWay(ancestorText, input.content, live.content) };
  }

  // The file's publication history, newest first — who published each revision, when, and why.
  async history(tenant: string, path: string, limit?: number): Promise<FsRevision[]> {
    if (!this.revisions) return [];
    return this.revisions.list(tenant, path, limit !== undefined ? { limit } : undefined);
  }

  // One past revision's content, for previewing or diffing it against the live file.
  async readRevision(tenant: string, path: string, revision: number): Promise<FsFileContent> {
    const blob = await this.fs.readRevisionBlob(tenant, path, revision);
    if (!blob) {
      throw new NotFoundError("NOT_FOUND", { path, revision }, `'${path}' has no revision ${revision}`);
    }
    return shapeContent(blob.entry, blob.data);
  }

  // Restore = publish the old bytes as a NEW revision (never rewrite history), so the rollback is itself an
  // audited publish: the ledger shows who rolled back, when, and which revision they brought back.
  async restoreRevision(tenant: string, path: string, revision: number, actor?: FsActor): Promise<FsEntry> {
    const blob = await this.fs.readRevisionBlob(tenant, path, revision);
    if (!blob) {
      throw new NotFoundError("NOT_FOUND", { path, revision }, `'${path}' has no revision ${revision}`);
    }
    return this.fs.write(tenant, path, blob.data, blob.entry.contentType, {
      ...(actor !== undefined ? { actor } : {}),
      restoredFrom: revision,
      message: `Restored revision ${revision}`,
    });
  }

  makeDirectory(tenant: string, path: string): Promise<FsEntry> {
    return this.fs.mkdir(tenant, path);
  }

  async remove(tenant: string, path: string, recursive: boolean): Promise<{ removed: number }> {
    const removed = await this.fs.remove(tenant, path, { recursive });
    if (removed === 0) throw new NotFoundError("NOT_FOUND", { path }, `'${path}' does not exist`);
    return { removed };
  }

  move(tenant: string, from: string, to: string): Promise<FsEntry> {
    return this.fs.move(tenant, from, to);
  }

  // The workspace's storage picture for Settings › Files: totals + per-top-level breakdown, walked through the
  // port (works identically over S3 and InMemory; the user never needs the object-storage console).
  async usage(tenant: string): Promise<FsUsage> {
    const budget = { left: USAGE_WALK_CAP, truncated: false };
    const top = await this.fs.list(tenant, "");
    const topLevel: FsUsageTopLevel[] = [];
    let files = 0;
    let bytes = 0;
    for (const entry of top) {
      const stats =
        entry.kind === "file" ? { files: 1, bytes: entry.size ?? 0 } : await this.walkUsage(tenant, entry.path, budget);
      topLevel.push({ path: entry.path, name: entry.name, kind: entry.kind, ...stats });
      files += stats.files;
      bytes += stats.bytes;
    }
    // Published history is REAL storage the tree walk cannot see (the revision blobs live outside it), and with
    // unlimited retention it outgrows the visible tree on any actively-edited workspace. Reporting it separately
    // keeps "what the workspace holds" honest without pretending old revisions are current files.
    const history = await this.revisions?.usage(tenant);
    return {
      files,
      bytes,
      truncated: budget.truncated,
      topLevel,
      ...(history ? { history } : {}),
    };
  }

  private async walkUsage(
    tenant: string,
    dir: string,
    budget: { left: number; truncated: boolean },
  ): Promise<{ files: number; bytes: number }> {
    if (budget.left <= 0) {
      budget.truncated = true;
      return { files: 0, bytes: 0 };
    }
    let files = 0;
    let bytes = 0;
    for (const entry of await this.fs.list(tenant, dir)) {
      if (budget.left-- <= 0) {
        budget.truncated = true;
        break;
      }
      if (entry.kind === "file") {
        files += 1;
        bytes += entry.size ?? 0;
      } else {
        const nested = await this.walkUsage(tenant, entry.path, budget);
        files += nested.files;
        bytes += nested.bytes;
      }
    }
    return { files, bytes };
  }

  // Empty the whole workspace filesystem — the Settings danger-zone action (admin-gated at the route). Removes
  // every top-level entry recursively; the tree itself (the tenant's bucket) stays, ready for new writes.
  //
  // History goes too, and ONLY here. Deleting one file keeps its revisions on purpose (the content stays
  // restorable, and "who deleted this and what did it say" stays answerable), but "empty the filesystem" is the
  // wipe: history no file references is a surprise to whoever pressed it and a silent storage cost, since
  // revision blobs live outside the tree this walk clears. `purgedRevisions` reports what went with it.
  async clear(tenant: string): Promise<{ removed: number; purgedRevisions: number }> {
    let removed = 0;
    for (const entry of await this.fs.list(tenant, "")) {
      removed += await this.fs.remove(tenant, entry.path, { recursive: true });
    }
    const purgedRevisions = (await this.revisions?.purge(tenant)) ?? 0;
    await this.fs.removeRevisionBlobs(tenant); // storage half; the ledger above is the audit half
    return { removed, purgedRevisions };
  }
}

// Text-vs-binary shaping, shared by the live read and the revision read so a past revision renders exactly like
// the file does today: text types come back utf8, everything else (and invalid utf-8) round-trips as base64.
//
// The stored type is authoritative EXCEPT when it is the generic fallback: `application/octet-stream` was never
// a decision about the file, it was "the registry had no row for this extension at write time". Re-guessing it
// on read makes every format the registry learns apply RETROACTIVELY — a `.go` or a `.xlsx` written last month
// opens as code or as a document today, with no migration and no rewrite of stored objects. The resolved type
// travels back on the entry, so the caller classifies the file the same way this did.
const FS_FALLBACK_CONTENT_TYPE = "application/octet-stream";
const FS_SNIFFED_TEXT_TYPE = "text/plain; charset=utf-8";

// The last line of the registry's defence: bytes whose extension means nothing to us. Valid utf-8 with no NUL is
// text — a config file with a house extension opens as text instead of being written off as a blob. Only ever
// applied to the FALLBACK type, so a declared binary is never second-guessed by content sniffing.
function sniffText(data: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

function shapeContent(entry: FsEntry, data: Uint8Array): FsFileContent {
  const stored = entry.contentType;
  const isFallback = stored === undefined || stored === FS_FALLBACK_CONTENT_TYPE;
  let contentType = isFallback ? guessFsContentType(entry.path) : stored;

  if (isFsTextContentType(contentType)) {
    const text = sniffText(data);
    // A text-typed object holding invalid utf-8 falls through to base64 below.
    if (text !== undefined) return { entry: resolveEntry(entry, stored, contentType), content: text, encoding: "utf8" };
  } else if (contentType === FS_FALLBACK_CONTENT_TYPE) {
    const text = sniffText(data);
    if (text !== undefined) {
      contentType = FS_SNIFFED_TEXT_TYPE;
      return { entry: resolveEntry(entry, stored, contentType), content: text, encoding: "utf8" };
    }
  }
  return {
    entry: resolveEntry(entry, stored, contentType),
    content: Buffer.from(data).toString("base64"),
    encoding: "base64",
  };
}

function resolveEntry(entry: FsEntry, stored: string | undefined, contentType: string): FsEntry {
  return contentType === stored ? entry : { ...entry, contentType };
}

function decodeBase64(path: string, content: string): Uint8Array {
  const compact = content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new BadRequestError("BAD_REQUEST", { path }, "content is not valid base64");
  }
  return new Uint8Array(Buffer.from(compact, "base64"));
}
