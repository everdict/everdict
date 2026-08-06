import { BadRequestError, UpstreamError } from "@everdict/contracts";
import type { RegistryWriter } from "./layer-append.js";
import type { RegistryAccess } from "./token-issuer.js";

// Copy an image INTO the workspace's namespace, so a world can be founded on it.
//
// Why this is not optional: `appendLayer` publishes "the base plus one layer" as a manifest in the world's own
// repository, and a manifest may only reference blobs that repository holds. The daemon path hid this — a
// `docker commit` push uploads the base's layers along with the new one, because the daemon already had them.
// The registry path has nothing locally, so founding a world from `debian:stable-slim` produced exactly one
// honest failure: "the base image … is not in this registry". Copying the base in is what the daemon was
// implicitly doing all along.
//
// Scope: single-platform manifests, resolved through an index when the source publishes one (a world runs on
// one platform, so picking the runnable child is the answer rather than a refusal — unlike appendLayer, where
// picking would silently choose which architecture a snapshot represents).

const PLATFORM_OS = "linux";
const PLATFORM_ARCH = "amd64";

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  platform?: { os?: string; architecture?: string };
}

interface ManifestBody {
  manifests?: Descriptor[]; // an index
  config?: Descriptor;
  layers?: Descriptor[];
}

// Reading the SOURCE, which is usually not our registry: a public base on Docker Hub, a workspace's BYO
// registry, or (when the base is already ours) the managed store itself. Kept as a seam so the transport —
// including whatever auth that registry demands — stays outside this file's business.
export interface ImageSource {
  // The manifest of `reference`, with its media type. `undefined` = the source does not have it.
  manifest(reference: string): Promise<{ body: unknown; mediaType: string } | undefined>;
  blob(digest: string): Promise<Buffer | undefined>;
}

export interface CopyImageResult {
  digest: string; // the manifest digest in the TARGET repository
  layers: number;
  copiedBlobs: number; // what actually moved (a blob the target already had is not re-uploaded)
}

// Copy `reference` from `source` into `repository:tag` of the managed registry.
export async function copyImage(
  source: ImageSource,
  writer: RegistryWriter,
  input: { repository: string; reference: string; tag: string },
  access: RegistryAccess[],
): Promise<CopyImageResult> {
  const found = await source.manifest(input.reference);
  if (!found)
    throw new BadRequestError(
      "BAD_REQUEST",
      { reference: input.reference },
      `the base image '${input.reference}' could not be read from its registry — a world is founded on an image the control plane can pull.`,
    );
  let body = found.body as ManifestBody;
  let mediaType = found.mediaType;
  if (body.manifests) {
    // An index: resolve to the runnable child. Attestation manifests advertise "unknown/unknown" and carry no
    // image config, so they are never picked.
    const runnable = body.manifests.filter(
      (m) => m.platform?.os && m.platform.os !== "unknown" && m.platform.architecture !== "unknown",
    );
    const child =
      runnable.find((m) => m.platform?.os === PLATFORM_OS && m.platform?.architecture === PLATFORM_ARCH) ?? runnable[0];
    if (!child?.digest)
      throw new BadRequestError(
        "BAD_REQUEST",
        { reference: input.reference },
        `the base image '${input.reference}' publishes no runnable platform to found a world on.`,
      );
    const resolved = await source.manifest(child.digest);
    if (!resolved)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { reference: input.reference, child: child.digest },
        "the base image's platform manifest is missing from its registry",
      );
    body = resolved.body as ManifestBody;
    mediaType = child.mediaType ?? resolved.mediaType;
  }
  if (!body.config?.digest || !Array.isArray(body.layers))
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { reference: input.reference },
      "the base image has no config or layers to copy",
    );

  // Blobs BEFORE the manifest that names them — a manifest referencing a blob the registry does not hold is
  // rejected, while an orphan blob is merely garbage.
  let copiedBlobs = 0;
  const digests = [body.config.digest, ...body.layers.map((l) => l.digest)].filter(
    (d): d is string => typeof d === "string",
  );
  for (const digest of digests) {
    if (await writer.headBlob(input.repository, digest, access)) continue; // already ours
    const bytes = await source.blob(digest);
    if (!bytes)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { reference: input.reference, digest },
        `the base image's blob ${digest} is missing from its registry`,
      );
    await writer.putBlob(input.repository, digest, bytes, access);
    copiedBlobs++;
  }

  const manifestBody = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType,
      config: body.config,
      layers: body.layers,
    }),
  );
  const { digest } = await writer.putManifest(input.repository, input.tag, manifestBody, mediaType, access);
  return { digest, layers: body.layers.length, copiedBlobs };
}
