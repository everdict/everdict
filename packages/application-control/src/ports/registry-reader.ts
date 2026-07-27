import type { ImageRegistryCoordinates, RegistryAuth } from "@everdict/contracts";

// A manifest inspect summary (best-effort — fields depend on the manifest kind).
export interface ImageManifestInfo {
  reference: string; // the tag/digest inspected
  digest?: string; // the Docker-Content-Digest of the manifest
  mediaType?: string; // the manifest media type (image manifest vs manifest list/index)
  platforms?: string[]; // "os/arch" entries, for a manifest list / OCI index
  layerCount?: number; // number of layers, for a single image manifest
}

// Read-only Docker Registry HTTP API v2 client (list tags / inspect a manifest) for ONE resolved registry — the
// adapter owns the base URL, the v2 bearer/basic token-auth handshake, media-type negotiation, and error remapping
// (a transport/non-2xx failure is a remapped AppError). Covers standard bearer/basic registries (GHCR, Harbor, Docker
// Hub, GAR, generic v2); AWS ECR (SigV4) is out of scope. Impl: apps/api infrastructure/registry.
export interface RegistryReader {
  // GET /v2/{repository}/tags/list → the tags (first page). `auth` absent → anonymous.
  listTags(coords: ImageRegistryCoordinates, auth: RegistryAuth | undefined, repository: string): Promise<string[]>;
  // GET /v2/{repository}/manifests/{reference} → the manifest summary (digest + media type + platforms/layers).
  inspectManifest(
    coords: ImageRegistryCoordinates,
    auth: RegistryAuth | undefined,
    repository: string,
    reference: string,
  ): Promise<ImageManifestInfo>;
}
