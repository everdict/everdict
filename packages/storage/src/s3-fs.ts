import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
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
import {
  FS_ROOT_ENTRY,
  assertFsBucketPrefix,
  fsAncestors,
  fsBucketFor,
  fsEntryName,
  fsRevisionBucketFor,
  fsRevisionKey,
  sortFsEntries,
} from "./fs-shared.js";

export interface S3WorkspaceFsOptions {
  endpoint: string; // S3 API endpoint (e.g. http://localhost:9100 = MinIO)
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // default us-east-1
  bucketPrefix?: string; // per-tenant bucket name prefix (default "everdict-fs")
}

const DELETE_CONCURRENCY = 16; // in-flight single-object deletes per wave (see deleteKeys)

function isS3NotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    e.name === "NotFound" || e.name === "NoSuchKey" || e.name === "NoSuchBucket" || e.$metadata?.httpStatusCode === 404
  );
}

// Workspace filesystem on S3-compatible object storage (incl. MinIO) — the DISTRIBUTED backend: every control-plane
// replica sees the same trees. Isolation is the BUCKET boundary: each tenant owns its own bucket
// (`<prefix>-<tenant>-<hash8>` via fsBucketFor — collision-proof naming), created lazily on first touch, so a
// tenant's tree is separated at the storage layer itself (per-tenant credentials/quotas/lifecycle policies attach
// to the bucket; deleting a workspace's data = dropping its bucket). Inside a bucket, keys ARE the canonical
// workspace-relative paths (`<path>`, empty-dir markers `<path>/`) — already normalized + traversal-rejected, and
// the tenant slug itself is validated before it can ever name a bucket.
export class S3WorkspaceFs implements WorkspaceFs {
  private readonly client: S3Client;
  private readonly prefix: string;
  private readonly ensured = new Set<string>(); // buckets confirmed to exist (per-process cache)

  constructor(opts: S3WorkspaceFsOptions) {
    this.prefix = assertFsBucketPrefix(opts.bucketPrefix ?? "everdict-fs"); // fail fast at composition time
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? "us-east-1",
      forcePathStyle: true, // MinIO requires path-style
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  // The tenant's bucket, created lazily on first touch (HeadBucket → CreateBucket; the create race between
  // replicas is benign — same artifact-store idiom). Cached per process so the common path costs nothing.
  private async bucketFor(tenant: string): Promise<string> {
    return this.ensureBucket(fsBucketFor(this.prefix, tenant));
  }

  // The tenant's revision bucket — same lazy creation, created only when a revision is actually published.
  private async revisionBucketFor(tenant: string): Promise<string> {
    return this.ensureBucket(fsRevisionBucketFor(this.prefix, tenant));
  }

  private async ensureBucket(bucket: string): Promise<string> {
    if (!this.ensured.has(bucket)) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => {});
      }
      this.ensured.add(bucket);
    }
    return bucket;
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

  private async headFile(bucket: string, path: string): Promise<FsEntry | undefined> {
    try {
      const res = await this.send("stat", () => this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: path })));
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

  private async hasAnyUnder(bucket: string, dirPath: string): Promise<boolean> {
    const res = await this.send("list", () =>
      this.client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${dirPath}/`, MaxKeys: 1 })),
    );
    return (res.KeyCount ?? 0) > 0;
  }

  private async assertAncestorsAreNotFiles(bucket: string, path: string): Promise<void> {
    for (const ancestor of fsAncestors(path)) {
      if (await this.headFile(bucket, ancestor)) {
        throw new ConflictError("CONFLICT", { path, ancestor }, `'${ancestor}' is a file, not a directory`);
      }
    }
  }

  // All keys under a dir (paginated, no delimiter) — the marker itself included when present.
  private async keysUnder(bucket: string, dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.send("list", () =>
        this.client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  // Deliberately per-key DeleteObject, NOT the batch DeleteObjects: MinIO — the storage this project ships in
  // its own self-hosted stack — requires a Content-MD5 header on DeleteObjects, which aws-sdk-js v3 stopped
  // sending when it moved to CRC32 checksums (no client option restores it; an explicit ChecksumAlgorithm does
  // not either — verified against minio:RELEASE.2024-12-18). The batch call therefore failed on EVERY such
  // deployment, taking recursive removes and DIRECTORY MOVES down with it — and a directory move copies before
  // it deletes, so the failure left the copy behind and duplicated the tree. Single-object deletes are accepted
  // everywhere; a bounded fan-out keeps a large sweep quick without flooding the endpoint.
  private async deleteKeys(bucket: string, keys: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
      const batch = keys.slice(i, i + DELETE_CONCURRENCY);
      await Promise.all(
        batch.map((Key) =>
          this.send("remove", () => this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key }))),
        ),
      );
      removed += batch.length;
    }
    return removed;
  }

  async list(tenant: string, dir: string): Promise<FsEntry[]> {
    const d = normalizeFsPath(dir);
    const bucket = await this.bucketFor(tenant);
    if (d !== "" && (await this.headFile(bucket, d))) {
      throw new BadRequestError("BAD_REQUEST", { path: d }, `'${d}' is a file, not a directory`);
    }
    const listPrefix = d === "" ? "" : `${d}/`;
    const entries: FsEntry[] = [];
    let token: string | undefined;
    do {
      const res = await this.send("list", () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: listPrefix,
            Delimiter: "/",
            ContinuationToken: token,
          }),
        ),
      );
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        const path = cp.Prefix.replace(/\/$/, "");
        entries.push({ path, name: fsEntryName(path), kind: "dir" });
      }
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key === listPrefix) continue; // skip the listed dir's own marker
        entries.push({
          path: obj.Key,
          name: fsEntryName(obj.Key),
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
    const bucket = await this.bucketFor(tenant);
    if (p === "") return FS_ROOT_ENTRY;
    const file = await this.headFile(bucket, p);
    if (file) return file;
    if (await this.hasAnyUnder(bucket, p)) return { path: p, name: fsEntryName(p), kind: "dir" };
    return undefined;
  }

  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const p = normalizeFsPath(path);
    const bucket = await this.bucketFor(tenant);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot read the filesystem root");
    try {
      const res = await this.send("read", () => this.client.send(new GetObjectCommand({ Bucket: bucket, Key: p })));
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
      if (await this.hasAnyUnder(bucket, p)) {
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
    const bucket = await this.bucketFor(tenant);
    if (!(await this.headFile(bucket, p)) && (await this.hasAnyUnder(bucket, p))) {
      throw new ConflictError("CONFLICT", { path: p }, `'${p}' is a directory`);
    }
    await this.assertAncestorsAreNotFiles(bucket, p);
    const type = contentType ?? guessFsContentType(p);
    await this.send("write", () =>
      this.client.send(new PutObjectCommand({ Bucket: bucket, Key: p, Body: data, ContentType: type })),
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
    const bucket = await this.bucketFor(tenant);
    if (await this.headFile(bucket, p)) throw new ConflictError("CONFLICT", { path: p }, `'${p}' is a file`);
    await this.assertAncestorsAreNotFiles(bucket, p);
    await this.send("mkdir", () =>
      this.client.send(new PutObjectCommand({ Bucket: bucket, Key: `${p}/`, Body: new Uint8Array() })),
    );
    return { path: p, name: fsEntryName(p), kind: "dir" };
  }

  async remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number> {
    const p = normalizeFsPath(path);
    if (p === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot remove the filesystem root");
    const bucket = await this.bucketFor(tenant);
    if (await this.headFile(bucket, p)) {
      await this.send("remove", () => this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: p })));
      return 1;
    }
    const keys = await this.keysUnder(bucket, p);
    if (keys.length === 0) return 0;
    const marker = `${p}/`;
    if (!opts?.recursive && keys.some((k) => k !== marker)) {
      throw new ConflictError("CONFLICT", { path: p }, `'${p}' is not empty (pass recursive to remove)`);
    }
    return this.deleteKeys(bucket, keys);
  }

  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    const src = normalizeFsPath(from);
    const dst = normalizeFsPath(to);
    if (src === "" || dst === "") throw new BadRequestError("BAD_REQUEST", {}, "cannot move the filesystem root");
    if (src === dst) throw new BadRequestError("BAD_REQUEST", { from: src }, "source and target are the same path");
    const bucket = await this.bucketFor(tenant);
    if ((await this.headFile(bucket, dst)) || (await this.hasAnyUnder(bucket, dst))) {
      throw new ConflictError("CONFLICT", { path: dst }, `'${dst}' already exists`);
    }
    await this.assertAncestorsAreNotFiles(bucket, dst);
    const srcFile = await this.headFile(bucket, src);
    if (srcFile) {
      await this.copyKey(bucket, src, dst);
      await this.send("remove", () => this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: src })));
      return { ...srcFile, path: dst, name: fsEntryName(dst), modifiedAt: new Date().toISOString() };
    }
    if (dst.startsWith(`${src}/`)) {
      throw new BadRequestError("BAD_REQUEST", { from: src, to: dst }, "cannot move a directory into itself");
    }
    const keys = await this.keysUnder(bucket, src);
    if (keys.length === 0) throw new NotFoundError("NOT_FOUND", { path: src }, `'${src}' does not exist`);
    const srcPrefix = `${src}/`;
    for (const key of keys) await this.copyKey(bucket, key, `${dst}/${key.slice(srcPrefix.length)}`);
    await this.deleteKeys(bucket, keys);
    return { path: dst, name: fsEntryName(dst), kind: "dir" };
  }

  // Immutable revision content, in the tenant's sibling revision bucket — invisible to every tree operation
  // above, which all scope themselves to the tree bucket. A move does NOT relocate these: the ledger rewrites
  // the path it stores, and the blob is addressed by (path, revision) at read time through that same ledger.
  async writeRevisionBlob(
    tenant: string,
    path: string,
    revision: number,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const p = normalizeFsPath(path);
    const bucket = await this.revisionBucketFor(tenant);
    await this.send("write-revision", () =>
      this.client.send(
        new PutObjectCommand({ Bucket: bucket, Key: fsRevisionKey(p, revision), Body: data, ContentType: contentType }),
      ),
    );
  }

  async readRevisionBlob(tenant: string, path: string, revision: number): Promise<FsFile | undefined> {
    const p = normalizeFsPath(path);
    const bucket = await this.revisionBucketFor(tenant);
    try {
      const res = await this.send("read-revision", () =>
        this.client.send(new GetObjectCommand({ Bucket: bucket, Key: fsRevisionKey(p, revision) })),
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
          revision,
        },
        data,
      };
    } catch (err) {
      if (isS3NotFound(err)) return undefined;
      throw err;
    }
  }

  private async copyKey(bucket: string, fromKey: string, toKey: string): Promise<void> {
    await this.send("move", () =>
      this.client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: encodeURIComponent(`${bucket}/${fromKey}`).replace(/%2F/g, "/"),
          Key: toKey,
        }),
      ),
    );
  }
}
