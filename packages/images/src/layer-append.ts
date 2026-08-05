import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { BadRequestError, InternalError, UpstreamError } from "@everdict/contracts";
import type { RegistryAccess } from "./token-issuer.js";

// Publish an image as "a base image plus ONE more layer", using nothing but the registry's own HTTP API.
//
// Why this exists: the first snapshot mechanism was `docker commit` against a local daemon, which is only
// available where the control plane and the container share a host. A session placed on a cluster — the whole
// point of moving worlds off the control-plane host — has no such daemon within reach, and the platform does
// not (and will not) run a build service. But an image is just a base plus layers, and appending one is pure
// registry protocol: upload a blob, rewrite the config's rootfs/history, PUT a manifest. Nothing here needs a
// builder, a daemon, or privileged anything, so the SAME code publishes a snapshot from a docker container, a
// Nomad alloc or a Kubernetes pod — the capture (a tar over exec) is the only part that differs.
//
// Deliberately narrow: single-platform image manifests only. An index (multi-arch) base is rejected rather
// than silently snapshotted as one of its children — a world is one running filesystem, and quietly picking
// an architecture would produce an image that boots somewhere the session never ran.

const MANIFEST_MEDIA_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
] as const;

const LAYER_MEDIA_TYPE = {
  "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.image.rootfs.diff.tar.gzip",
} as const;

const CONFIG_MEDIA_TYPE = {
  "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.container.image.v1+json",
} as const;

type ManifestMediaType = (typeof MANIFEST_MEDIA_TYPES)[number];

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}

interface ImageManifest {
  schemaVersion: number;
  mediaType?: string;
  config: Descriptor;
  layers: Descriptor[];
  manifests?: unknown[]; // present on an index — rejected
}

interface ImageConfig {
  rootfs?: { type?: string; diff_ids?: string[] };
  history?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AppendLayerInput {
  repository: string; // full path in the registry ("<namespace>/<name>")
  baseReference: string; // tag or digest the new image builds ON — the image the session booted
  tag: string; // the tag to publish under
  layerGzip: Buffer; // the captured filesystem as a gzipped tar
  createdBy?: string; // history line for the new layer (what a reader sees in the build recipe)
  created?: string; // ISO timestamp for the history entry — injected, never read off the clock here
}

export interface AppendLayerResult {
  digest: string; // the published manifest digest — what a spec pins
  size: number;
  layerDigest: string;
}

// The registry calls this needs beyond the read-only client: blob existence, blob upload, manifest write.
// Kept as its own seam (rather than growing ManagedRegistryApi) because publishing is a different authority
// than reading — a caller holding only the reader cannot be tricked into writing.
export interface RegistryWriter {
  // Raw GET of a blob (config JSON). Returns undefined on 404 so a caller can say what is missing.
  getBlob(repository: string, digest: string, access: RegistryAccess[]): Promise<Buffer | undefined>;
  headBlob(repository: string, digest: string, access: RegistryAccess[]): Promise<boolean>;
  // Monolithic upload: POST an upload session, PUT the bytes with ?digest=. Returns the digest the registry
  // acknowledged, which is what the manifest must reference.
  putBlob(repository: string, digest: string, body: Buffer, access: RegistryAccess[]): Promise<void>;
  getManifest(
    repository: string,
    reference: string,
    access: RegistryAccess[],
  ): Promise<{ body: unknown; mediaType: string } | undefined>;
  putManifest(
    repository: string,
    reference: string,
    body: Buffer,
    mediaType: string,
    access: RegistryAccess[],
  ): Promise<{ digest: string }>;
}

export function sha256Of(body: Buffer): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

// base image + one layer → a new manifest under `tag`. The layer's UNCOMPRESSED digest (diffID) goes into the
// config's rootfs, its COMPRESSED digest into the manifest — conflating the two is the classic way to publish
// an image that pulls and then fails to unpack, so both are computed here rather than passed in.
export async function appendLayer(
  writer: RegistryWriter,
  input: AppendLayerInput,
  access: RegistryAccess[],
): Promise<AppendLayerResult> {
  const found = await writer.getManifest(input.repository, input.baseReference, access);
  if (!found)
    throw new BadRequestError(
      "BAD_REQUEST",
      { repository: input.repository, reference: input.baseReference },
      `the base image ${input.repository}:${input.baseReference} is not in this registry — a snapshot extends an image it can read.`,
    );
  const manifest = found.body as ImageManifest;
  if (manifest.manifests !== undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      { repository: input.repository, reference: input.baseReference },
      "the base image is a multi-platform index — snapshotting would have to pick one platform, and a world is one running filesystem.",
    );
  const mediaType: ManifestMediaType = MANIFEST_MEDIA_TYPES.includes(found.mediaType as ManifestMediaType)
    ? (found.mediaType as ManifestMediaType)
    : "application/vnd.oci.image.manifest.v1+json";
  if (!manifest.config?.digest || !Array.isArray(manifest.layers))
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { repository: input.repository },
      "the registry returned a manifest with no config or layers",
    );

  const configBytes = await writer.getBlob(input.repository, manifest.config.digest, access);
  if (!configBytes)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { repository: input.repository, digest: manifest.config.digest },
      "the base image's config blob is missing from the registry",
    );
  let config: ImageConfig;
  try {
    config = JSON.parse(configBytes.toString("utf8")) as ImageConfig;
  } catch (err) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { repository: input.repository },
      `the base image's config is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const layerDigest = sha256Of(input.layerGzip);
  let diffId: string;
  try {
    diffId = sha256Of(gunzipSync(input.layerGzip));
  } catch (err) {
    throw new InternalError(
      "DRIVER_SNAPSHOT_FAILED",
      { repository: input.repository },
      `the captured layer is not a gzip stream: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Upload the layer first: a manifest that references a blob the registry does not hold is rejected, and an
  // orphan blob is merely garbage. Skip the upload when the registry already has it (a re-snapshot of an
  // unchanged tree produces the identical layer).
  if (!(await writer.headBlob(input.repository, layerDigest, access)))
    await writer.putBlob(input.repository, layerDigest, input.layerGzip, access);

  const nextConfig: ImageConfig = {
    ...config,
    ...(input.created !== undefined ? { created: input.created } : {}),
    rootfs: {
      type: config.rootfs?.type ?? "layers",
      diff_ids: [...(config.rootfs?.diff_ids ?? []), diffId],
    },
    history: [
      ...(config.history ?? []),
      {
        ...(input.created !== undefined ? { created: input.created } : {}),
        created_by: input.createdBy ?? "everdict snapshot",
      },
    ],
  };
  const configBody = Buffer.from(JSON.stringify(nextConfig));
  const configDigest = sha256Of(configBody);
  if (!(await writer.headBlob(input.repository, configDigest, access)))
    await writer.putBlob(input.repository, configDigest, configBody, access);

  const nextManifest = {
    schemaVersion: 2,
    mediaType,
    config: { mediaType: CONFIG_MEDIA_TYPE[mediaType], digest: configDigest, size: configBody.length },
    layers: [
      ...manifest.layers,
      { mediaType: LAYER_MEDIA_TYPE[mediaType], digest: layerDigest, size: input.layerGzip.length },
    ],
  };
  const manifestBody = Buffer.from(JSON.stringify(nextManifest));
  const { digest } = await writer.putManifest(input.repository, input.tag, manifestBody, mediaType, access);
  return { digest, size: manifestBody.length, layerDigest };
}
