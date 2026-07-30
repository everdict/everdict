import type {
  ImageInspect,
  ImageRegistryCoordinates,
  ImageRegistryProbeResult,
  RegistryAuth,
} from "@everdict/contracts";

// The connection-probe outcome the reader classifies — the ImageRegistryProbeResult minus `credential` (which of
// the configured secrets was used is the service's concern; the reader only knows whether a credential was given).
export type RegistryConnectivity = Omit<ImageRegistryProbeResult, "credential">;

// A manifest inspect (best-effort — fields depend on the manifest kind and on what the backend resolves; the
// managed store reads the OCI config blob for the build history, a BYO reader may stop at the manifest summary).
// The shape is the contract's `ImageInspectSchema` — one schema serves the port, the wire response, and the docs.
export type ImageManifestInfo = ImageInspect;

// Read-only Docker Registry HTTP API v2 client (list tags / inspect a manifest) for ONE resolved registry — the
// adapter owns the base URL, the v2 bearer/basic token-auth handshake, media-type negotiation, and error remapping
// (a transport/non-2xx failure is a remapped AppError). Covers standard bearer/basic registries (GHCR, Harbor, Docker
// Hub, GAR, generic v2); AWS ECR (SigV4) is out of scope. Impl: apps/api infrastructure/registry.
export interface RegistryReader {
  // Connectivity + auth probe — GET /v2/ (the registry-API version endpoint) with the same bearer/basic
  // token-auth handshake, CLASSIFIED into a result (never throws — a probe classifies): 2xx after the handshake
  // = reachable, a rejected challenge = reason "auth", a transport/DNS/timeout failure = "unreachable", any other
  // non-2xx = "error". `auth` absent → an anonymous connectivity probe.
  checkConnection(coords: ImageRegistryCoordinates, auth: RegistryAuth | undefined): Promise<RegistryConnectivity>;
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
