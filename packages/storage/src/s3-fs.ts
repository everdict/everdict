import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { FsFile, WorkspaceFs } from "@everdict/application-control";
import {
  BadRequestError,
  ConflictError,
  FS_FILE_MAX_BYTES,
  type FsEntry,
  NotFoundError,
  UpstreamError,
  guessFsContentType,
  normalizeFsPath,
} from "@everdict/contracts";
import { FS_ROOT_ENTRY, assertFsTenant, fsAncestors, fsEntryName, sortFsEntries } from "./fs-shared.js";

export interface S3WorkspaceFsOptions {
  endpoint: string; // S3 API endpoint (e.g. http://localhost:9100 = MinIO)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // default us-east-1
  keyPrefix?: string; // object-key namespace inside the bucket (default "fs/")
}

function isS3NotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

// Workspace filesystem on S3-compatible object storage (incl. MinIO) — the DISTRIBUTED backend: every control-plane
// replica sees the same tree. Layout: `fs/<tenant>/<path>` per file, `fs/<tenant>/<path>/` as an empty marker per
// explicitly-created dir (so empty dirs survive; implicit dirs derive from key prefixes). The tenant prefix is
// computed inside every operation from an already-validated slug — a caller-supplied path can never cross it.
export class S3WorkspaceFs implements WorkspaceFs {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly opts: S3WorkspaceFsOptions) {
    this.prefix = opts.keyPrefix ?? "fs/";
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? "us-east-1",
      forcePathStyle: true, // MinIO requires path-style
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  private tenantRoot(tenant: string): string {
    return `${this.prefix}${assertFsTenant(tenant)}/`;
  }

  private async send<T>(op: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isS3NotFound(err)) throw err; // flow control for callers that probe existence
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { op, cause: err instanceof Error ? err.message : String(err) },
        `filesystem storage ${op} failed`,
      );
    }
  }

  private async headFile(root: string, path: string): Promise<FsEntry | undefined> {
    try {
      const res = await this.send("stat", () =>
        this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: `${root}${path}` })),
      );
      return {
        path,
        name: fsEntryName(path),
        kind: "file",
        size: res.ContentLength ?? undefined,
        contentType: res.ContentType ?? undefined,
        modifiedAt: res.LastModified?.toISOString(),
      };
    } catch (err) {
      if (isS3NotFound(err)) return undefined;
      throw err;
    }
  }

  private async hasAnyUnder(root: string, dirPath: string): Promise<boolean> {
    const res = await this.send("list", () =>
      this.client.send(
        new ListObjectsV2Command({ Bucket: this.opts.bucket, Prefix: `${root}${dirPath}/`, MaxKeys: 1 }),
      ),
    );
    return (res.KeyCount ?? 0) > 0;
  }

  private async isDir(root: string, path: string): Promise<boolean> {
    if (path === "") return true;
    return this.hasAnyUnder(root, path); // the marker key `<path>/` counts too
  }

  private async assertAncestorsAreNotFiles(root: string, path: string): Promise<void> {
    for (const ancestor of fsAncestors(path)) {
      if (await this.headFile(root, ancestor)) {
        throw new ConflictError("CONFLICT", { path, ancestor }, `'${ancestor}' is a file, not a directory`);
      }
    }
  }

  // All keys under a dir (paginated, no delimiter) — the marker itself included when present.
  private async keysUnder(root: string, dirPath: string): Promise<string[]> {
    const prefix = `${root}${dirPath}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.send("list", () =>
        this.client.send(
          new ListObjectsV2Command({ Bucket: this.opts.bucket, Prefix: prefix, ContinuationToken: token }),
        ),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  private async deleteKeys(keys: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.send("remove", () =>
        this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.opts.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        ),
      );
      removed += batch.length;
    }
    return removed;
  }

  async list(tenant: string, dir: string): Promise<FsEntry[]> {
    const d = normalizeFsPath(dir);
    const root = this.tenantRoot(tenant);
    if (d !== "" && (await this.headFile(root, d))) {
      throw new BadRequestError("BAD_REQUEST", { path: d }, `'${d}' is a file, not a directory`);
    }
    const listPrefix = d === "" ? root : `${root}${d}/`;
    const entries: FsEntry[] = [];
    let token: string | undefined;
    do {
      const res = await this.send("list", () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.opts.bucket,
            Prefix: listPrefix,
            Delimiter: "/",
            ContinuationToken: token,
          }),
        ),
      );
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        const path = cp.Prefix.slice(root.length).replace(/\/$/, "");
        entries.push({ path, name: fsEntryName(path), kind: "dir" });
      }
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key === listPrefix) continue; // skip the listed dir's own marker
        const path = obj.Key.slice(root.length);
        entries.push({
          path,
          name: fsEntryName(path),
          kind: "file",
          size: obj.Size ?? undefined,
          modifiedAt: obj.LastModified?.toISOString(),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return sortFsEntries(entries);
  }

  async stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    const p = normalizeFsPath(path);
    const root = this.tenantRoot(tenant);
    if (p === "") return FS_ROOT_ENTRY;
    const file = await this.headFile(root, p);
    if (file) return file;
    if (await this.hasAnyUnder(root, p)) return { path: p, name: fsEntryName(p), kind: "dir" };
    return undefined;
  }

  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const p = normalizeFsPath(path);
    const root = this.tenantRoot(tenant);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot read the filesystem root");
    try {
      const res = await this.send("read", () =>
        this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: `${root}${p}` })),
      );
      const data = (await res.Body?.transformToByteArray()) ?? new Uint8Array();
      return {
        entry: {
          path: p,
          name: fsEntryName(p),
          kind: "file",
          size: data.byteLength,
          contentType: res.ContentType ?? undefined,
          modifiedAt: res.LastModified?.toISOString(),
        },
        data,
      };
    } catch (err) {
      if (!isS3NotFound(err)) throw err;
      if (await this.hasAnyUnder(root, p)) {
        throw new BadRequestError("BAD_REQUEST", { path: p }, `'${p}' is a directory, not a file`);
      }
      return undefined;
    }
  }

  async write(tenant: string, path: string, data: Uint8Array, contentType?: string): Promise<FsEntry> {
    const p = normalizeFsPath(path);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot write to the filesystem root");
    if (data.byteLength > FS_FILE_MAX_BYTES) {
      throw new BadRequestError("BAD_REQUEST", { path: p, size: data.byteLength }, "file exceeds the size limit");
    }
    const root = this.tenantRoot(tenant);
    if (!(await this.headFile(root, p)) && (await this.hasAnyUnder(root, p))) {
      throw new ConflictError("CONFLICT", { path: p }, `'${p}' is a directory`);
    }
    await this.assertAncestorsAreNotFiles(root, p);
    const type = contentType ?? guessFsContentType(p);
    await this.send("write", () =>
      this.client.send(
        new PutObjectCommand({ Bucket: this.opts.bucket, Key: `${root}${p}`, Body: data, ContentType: type }),
      ),
    );
    return {
      path: p,
      name: fsEntryName(p),
      kind: "file",
      size: data.byteLength,
      contentType: type,
      modifiedAt: new Date().toISOString(),
    };
  }

  async mkdir(tenant: string, path: string): Promise<FsEntry> {
    const p = normalizeFsPath(path);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "the filesystem root already exists");
    const root = this.tenantRoot(tenant);
    if (await this.headFile(root, p)) throw new ConflictError("CONFLICT", { path: p }, `'${p}' is a file`);
    await this.assertAncestorsAreNotFiles(root, p);
    await this.send("mkdir", () =>
      this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: `${root}${p}/`, Body: new Uint8Array() })),
    );
    return { path: p, name: fsEntryName(p), kind: "dir" };
  }

  async remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number> {
    const p = normalizeFsPath(path);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot remove the filesystem root");
    const root = this.tenantRoot(tenant);
    if (await this.headFile(root, p)) {
      await this.send("remove", () =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: `${root}${p}` })),
      );
      return 1;
    }
    const keys = await this.keysUnder(root, p);
    if (keys.length === 0) return 0;
    const marker = `${root}${p}/`;
    if (!opts?.recursive && keys.some((k) => k !== marker)) {
      throw new ConflictError("CONFLICT", { path: p }, `'${p}' is not empty (pass recursive to remove)`);
    }
    return this.deleteKeys(keys);
  }

  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    const src = normalizeFsPath(from);
    const dst = normalizeFsPath(to);
    if (src === "" || dst === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot move the filesystem root");
    if (src === dst) throw new BadRequestError("BAD_REQUEST", { from: src }, "source and target are the same path");
    const root = this.tenantRoot(tenant);
    if ((await this.headFile(root, dst)) || (await this.hasAnyUnder(root, dst))) {
      throw new ConflictError("CONFLICT", { path: dst }, `'${dst}' already exists`);
    }
    await this.assertAncestorsAreNotFiles(root, dst);
    const srcFile = await this.headFile(root, src);
    if (srcFile) {
      await this.copyKey(`${root}${src}`, `${root}${dst}`);
      await this.send("remove", () =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: `${root}${src}` })),
      );
      return { ...srcFile, path: dst, name: fsEntryName(dst), modifiedAt: new Date().toISOString() };
    }
    if (dst.startsWith(`${src}/`)) {
      throw new BadRequestError("BAD_REQUEST", { from: src, to: dst }, "cannot move a directory into itself");
    }
    const keys = await this.keysUnder(root, src);
    if (keys.length === 0) throw new NotFoundError("NOT_FOUND", { path: src }, `'${src}' does not exist`);
    const srcPrefix = `${root}${src}/`;
    const dstPrefix = `${root}${dst}/`;
    for (const key of keys) await this.copyKey(key, `${dstPrefix}${key.slice(srcPrefix.length)}`);
    await this.deleteKeys(keys);
    return { path: dst, name: fsEntryName(dst), kind: "dir" };
  }

  private async copyKey(fromKey: string, toKey: string): Promise<void> {
    await this.send("move", () =>
      this.client.send(
        new CopyObjectCommand({
          Bucket: this.opts.bucket,
          CopySource: encodeURIComponent(`${this.opts.bucket}/${fromKey}`).replace(/%2F/g, "/"),
          Key: toKey,
        }),
      ),
    );
  }
}
