import type { WorkspaceFs } from "@everdict/application-control";
import type { FsFile } from "@everdict/application-control";
import {
  BadRequestError,
  ConflictError,
  FS_FILE_MAX_BYTES,
  type FsEntry,
  NotFoundError,
  guessFsContentType,
  normalizeFsPath,
} from "@everdict/contracts";
import { FS_ROOT_ENTRY, assertFsTenant, fsAncestors, fsEntryName, sortFsEntries } from "./fs-shared.js";

interface StoredFile {
  data: Uint8Array;
  contentType: string;
  modifiedAt: string;
}

interface TenantTree {
  files: Map<string, StoredFile>; // canonical path → file
  dirs: Set<string>; // explicit dirs (mkdir markers); implicit dirs derive from file paths
  revisions: Map<string, StoredFile>; // "<path>@<revision>" → the immutable copy published under that number
}

// In-process workspace filesystem for dev/test. Per-tenant maps — one tenant can never see another's tree
// (same posture as the InMemory result stores). Not persisted/shared.
export class InMemoryWorkspaceFs implements WorkspaceFs {
  private readonly tenants = new Map<string, TenantTree>();

  private tree(tenant: string): TenantTree {
    const key = assertFsTenant(tenant);
    let tree = this.tenants.get(key);
    if (!tree) {
      tree = { files: new Map(), dirs: new Set(), revisions: new Map() };
      this.tenants.set(key, tree);
    }
    return tree;
  }

  private isDir(tree: TenantTree, path: string): boolean {
    if (path === "") return true;
    if (tree.dirs.has(path)) return true;
    const prefix = `${path}/`;
    for (const p of tree.files.keys()) if (p.startsWith(prefix)) return true;
    for (const d of tree.dirs) if (d.startsWith(prefix)) return true;
    return false;
  }

  // A file may never sit on another file's path ("a" the file vs "a/b") — the guard both writers share.
  private assertAncestorsAreNotFiles(tree: TenantTree, path: string): void {
    for (const ancestor of fsAncestors(path)) {
      if (tree.files.has(ancestor)) {
        throw new ConflictError("CONFLICT", { path, ancestor }, `'${ancestor}' is a file, not a directory`);
      }
    }
  }

  private fileEntry(path: string, file: StoredFile): FsEntry {
    return {
      path,
      name: fsEntryName(path),
      kind: "file",
      size: file.data.byteLength,
      contentType: file.contentType,
      modifiedAt: file.modifiedAt,
    };
  }

  async list(tenant: string, dir: string): Promise<FsEntry[]> {
    const d = normalizeFsPath(dir);
    const tree = this.tree(tenant);
    if (d !== "" && !this.isDir(tree, d)) {
      if (tree.files.has(d)) throw new BadRequestError("BAD_REQUEST", { path: d }, `'${d}' is a file, not a directory`);
      return [];
    }
    const prefix = d === "" ? "" : `${d}/`;
    const children = new Map<string, FsEntry>();
    for (const [path, file] of tree.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) children.set(rest, this.fileEntry(path, file));
      else {
        const name = rest.slice(0, slash);
        if (!children.has(name)) children.set(name, { path: `${prefix}${name}`, name, kind: "dir" });
      }
    }
    for (const dirPath of tree.dirs) {
      if (!dirPath.startsWith(prefix) || dirPath === d) continue;
      const rest = dirPath.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (!children.has(name)) children.set(name, { path: `${prefix}${name}`, name, kind: "dir" });
    }
    return sortFsEntries([...children.values()]);
  }

  async stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    const p = normalizeFsPath(path);
    const tree = this.tree(tenant);
    if (p === "") return FS_ROOT_ENTRY;
    const file = tree.files.get(p);
    if (file) return this.fileEntry(p, file);
    if (this.isDir(tree, p)) return { path: p, name: fsEntryName(p), kind: "dir" };
    return undefined;
  }

  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const p = normalizeFsPath(path);
    const tree = this.tree(tenant);
    const file = tree.files.get(p);
    if (file) return { entry: this.fileEntry(p, file), data: file.data };
    if (this.isDir(tree, p)) {
      throw new BadRequestError("BAD_REQUEST", { path: p }, `'${p}' is a directory, not a file`);
    }
    return undefined;
  }

  async write(tenant: string, path: string, data: Uint8Array, contentType?: string): Promise<FsEntry> {
    const p = normalizeFsPath(path);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot write to the filesystem root");
    if (data.byteLength > FS_FILE_MAX_BYTES) {
      throw new BadRequestError("BAD_REQUEST", { path: p, size: data.byteLength }, "file exceeds the size limit");
    }
    const tree = this.tree(tenant);
    if (!tree.files.has(p) && this.isDir(tree, p)) {
      throw new ConflictError("CONFLICT", { path: p }, `'${p}' is a directory`);
    }
    this.assertAncestorsAreNotFiles(tree, p);
    const file: StoredFile = {
      data,
      contentType: contentType ?? guessFsContentType(p),
      modifiedAt: new Date().toISOString(),
    };
    tree.files.set(p, file);
    return this.fileEntry(p, file);
  }

  async mkdir(tenant: string, path: string): Promise<FsEntry> {
    const p = normalizeFsPath(path);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "the filesystem root already exists");
    const tree = this.tree(tenant);
    if (tree.files.has(p)) throw new ConflictError("CONFLICT", { path: p }, `'${p}' is a file`);
    this.assertAncestorsAreNotFiles(tree, p);
    tree.dirs.add(p); // idempotent (mkdir -p); ancestors stay implicit
    return { path: p, name: fsEntryName(p), kind: "dir" };
  }

  async remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number> {
    const p = normalizeFsPath(path);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot remove the filesystem root");
    const tree = this.tree(tenant);
    if (tree.files.has(p)) {
      tree.files.delete(p);
      return 1;
    }
    if (!this.isDir(tree, p)) return 0;
    const prefix = `${p}/`;
    const childFiles = [...tree.files.keys()].filter((f) => f.startsWith(prefix));
    const childDirs = [...tree.dirs].filter((d) => d.startsWith(prefix));
    if (!opts?.recursive && (childFiles.length > 0 || childDirs.length > 0)) {
      throw new ConflictError("CONFLICT", { path: p }, `'${p}' is not empty (pass recursive to remove)`);
    }
    let removed = 0;
    for (const f of childFiles) {
      tree.files.delete(f);
      removed++;
    }
    for (const d of childDirs) {
      tree.dirs.delete(d);
      removed++;
    }
    if (tree.dirs.delete(p)) removed++;
    return removed;
  }

  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    const src = normalizeFsPath(from);
    const dst = normalizeFsPath(to);
    if (src === "" || dst === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot move the filesystem root");
    if (src === dst) throw new BadRequestError("BAD_REQUEST", { from: src }, "source and target are the same path");
    const tree = this.tree(tenant);
    const srcFile = tree.files.get(src);
    const srcIsDir = !srcFile && this.isDir(tree, src);
    if (!srcFile && !srcIsDir) throw new NotFoundError("NOT_FOUND", { path: src }, `'${src}' does not exist`);
    if (srcIsDir && dst.startsWith(`${src}/`)) {
      throw new BadRequestError("BAD_REQUEST", { from: src, to: dst }, "cannot move a directory into itself");
    }
    if (tree.files.has(dst) || this.isDir(tree, dst)) {
      throw new ConflictError("CONFLICT", { path: dst }, `'${dst}' already exists`);
    }
    this.assertAncestorsAreNotFiles(tree, dst);
    if (srcFile) {
      tree.files.delete(src);
      const moved: StoredFile = { ...srcFile, modifiedAt: new Date().toISOString() };
      tree.files.set(dst, moved);
      return this.fileEntry(dst, moved);
    }
    const prefix = `${src}/`;
    for (const [path, file] of [...tree.files]) {
      if (!path.startsWith(prefix)) continue;
      tree.files.delete(path);
      tree.files.set(`${dst}/${path.slice(prefix.length)}`, file);
    }
    for (const d of [...tree.dirs]) {
      if (d === src) {
        tree.dirs.delete(d);
        tree.dirs.add(dst);
      } else if (d.startsWith(prefix)) {
        tree.dirs.delete(d);
        tree.dirs.add(`${dst}/${d.slice(prefix.length)}`);
      }
    }
    if (!this.isDir(tree, dst)) tree.dirs.add(dst); // an empty explicit dir stays a dir after the move
    return { path: dst, name: fsEntryName(dst), kind: "dir" };
  }

  // Revision blobs live in their own map — never in `files`, so they can never appear in a listing or be walked
  // by usage/clear (the in-memory mirror of the S3 adapter's separate revision bucket).
  async writeRevisionBlob(
    tenant: string,
    path: string,
    revision: number,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const p = normalizeFsPath(path);
    this.tree(tenant).revisions.set(`${p}@${revision}`, { data, contentType, modifiedAt: new Date().toISOString() });
  }

  async readRevisionBlob(tenant: string, path: string, revision: number): Promise<FsFile | undefined> {
    const p = normalizeFsPath(path);
    const hit = this.tree(tenant).revisions.get(`${p}@${revision}`);
    if (!hit) return undefined;
    return { entry: { ...this.fileEntry(p, hit), revision }, data: hit.data };
  }
}
