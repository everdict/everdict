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
}

function decodeBase64(path: string, content: string): Uint8Array {
  const compact = content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new BadRequestError("BAD_REQUEST", { path }, "content is not valid base64");
  }
  return new Uint8Array(Buffer.from(compact, "base64"));
}
