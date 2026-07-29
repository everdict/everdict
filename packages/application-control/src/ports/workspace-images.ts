import type { ImageGrant, ImageRepo } from "@everdict/contracts";
import type { ImageManifestInfo } from "./registry-reader.js";

// The workspace image store port — everdict's OWN per-workspace image namespace, in the exact idiom of `WorkspaceFs`:
// the tenant is the FIRST argument of every method and the implementation maps it to a namespace the caller cannot
// escape (isolation lives in the adapter, not in caller discipline).
//
// Where it differs from the filesystem, and why: `S3WorkspaceFs` gets a BUCKET per tenant, but a registry process must
// serve every repository it hosts, so a bucket per tenant would mean a REGISTRY per tenant. The boundary therefore
// moves one layer up — the control plane is the registry's authorization server, and the isolation guarantee becomes
// "a grant scoped to another workspace's namespace is never minted, so it cannot exist". The invariant is unchanged;
// only its enforcement point moves from storage to signature. Do not "fix" this back to a bucket per tenant.
//
// Implementations: ManagedImageStore (bundled OCI registry + our token server), ByoImageStore (the workspace's own
// registered registries — today's `WorkspaceSettings.imageRegistries[]`, demoted from the model to one adapter),
// InMemoryImageStore (dev/test). Design: docs/architecture/managed-image-store.md
export interface WorkspaceImages {
  // The endpoint refs in this store are addressed by — registry host[:port], reachable from EVERY execution node
  // (including a self-hosted runner on a user's machine), so it is an operator-configured URL, not a container name.
  readonly endpoint: string;

  // The workspace's repository namespace (`imageRepoFor`) — what `classifyImageRef` compares against to answer
  // "managed", and the prefix an author's ref must carry to be one of ours.
  namespaceFor(tenant: string): string;

  // Repositories the workspace owns. Listing surfaces (Settings › Images) render these; `tags` may be omitted by
  // backends that cannot resolve them in one call.
  listRepositories(tenant: string): Promise<ImageRepo[]>;

  // Tags of one repository in the workspace's namespace. Missing repository → NotFoundError.
  listTags(tenant: string, repository: string): Promise<string[]>;

  // Manifest summary for a tag or digest — the read behind digest pinning and provenance display.
  inspect(tenant: string, repository: string, reference: string): Promise<ImageManifestInfo>;

  // A short-lived push authorization for ONE repository in the workspace's namespace (`everdict image push`).
  // The repository is created on first push; the caller uses the grant and discards it (never persisted).
  mintPushGrant(tenant: string, repository: string): Promise<ImageGrant>;

  // Short-lived pull authorizations covering these image refs — ONE grant per endpoint, carrying MANY repository
  // scopes, which is what lets a multi-service topology authenticate every image with a single credential.
  // Refs the workspace may not pull are simply omitted (warn-not-block: an uncovered image fails at pull time with
  // the registry's own error, not with a dispatch-time gate that would break pre-loaded/local-registry workflows).
  // Cross-tenant reach is decided here: a ref in another workspace's namespace is granted only when a capability
  // declaring it is consumable by this tenant (`canConsumeCapability`) — no publisher credential is ever handed over.
  mintPullGrant(tenant: string, refs: string[]): Promise<ImageGrant[]>;

  // Delete a whole repository, or one reference within it. Returns the number of manifests removed (0 = nothing there).
  remove(tenant: string, repository: string, reference?: string): Promise<number>;

  // What the workspace occupies — feeds the same usage metering the filesystem reports into. `bytes` is optional
  // because a registry exposes no size API: deriving it means walking every manifest's blob list, so a backend
  // that cannot answer cheaply omits it rather than reporting a number it guessed.
  usage(tenant: string): Promise<{ repositories: number; bytes?: number }>;
}
