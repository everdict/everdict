import {
  BadRequestError,
  type FsEntry,
  NotFoundError,
  guessFsContentType,
  isFsTextContentType,
} from "@everdict/contracts";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

export interface WriteFsFileInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64"; // default utf8; base64 for binary payloads
  contentType?: string; // default: guessed from the extension
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
}

const USAGE_WALK_CAP = 20_000; // max entries visited per usage sweep — keeps a huge tree from stalling Settings

// The workspace-filesystem use-cases — response shaping over the WorkspaceFs port: text-vs-binary encoding on
// read, base64 decode on write, a read/remove miss mapped to 404. Path safety + tenant isolation live in the
// port implementations (every operation normalizes + prefix-scopes internally); this layer never re-derives them.
export class FsService {
  constructor(private readonly fs: WorkspaceFs) {}

  list(tenant: string, path?: string): Promise<FsEntry[]> {
    return this.fs.list(tenant, path ?? "");
  }

  stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    return this.fs.stat(tenant, path);
  }

  async readFile(tenant: string, path: string): Promise<FsFileContent> {
    const file = await this.fs.read(tenant, path);
    if (!file) throw new NotFoundError("NOT_FOUND", { path }, `'${path}' does not exist`);
    const contentType = file.entry.contentType ?? guessFsContentType(file.entry.path);
    if (isFsTextContentType(contentType)) {
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
        return { entry: file.entry, content, encoding: "utf8" };
      } catch {
        // a text-typed object holding invalid utf-8 still round-trips below as base64
      }
    }
    return { entry: file.entry, content: Buffer.from(file.data).toString("base64"), encoding: "base64" };
  }

  writeFile(tenant: string, input: WriteFsFileInput): Promise<FsEntry> {
    const data =
      input.encoding === "base64" ? decodeBase64(input.path, input.content) : new TextEncoder().encode(input.content);
    return this.fs.write(tenant, input.path, data, input.contentType);
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
    return { files, bytes, truncated: budget.truncated, topLevel };
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
  async clear(tenant: string): Promise<{ removed: number }> {
    let removed = 0;
    for (const entry of await this.fs.list(tenant, "")) {
      removed += await this.fs.remove(tenant, entry.path, { recursive: true });
    }
    return { removed };
  }
}

function decodeBase64(path: string, content: string): Uint8Array {
  const compact = content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new BadRequestError("BAD_REQUEST", { path }, "content is not valid base64");
  }
  return new Uint8Array(Buffer.from(compact, "base64"));
}
