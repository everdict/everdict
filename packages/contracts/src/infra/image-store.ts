import { z } from "zod";

// The managed image store's wire shapes — everdict's OWN per-workspace image namespace, the image analog of the
// workspace filesystem. A registry process must serve every repository it hosts, so the isolation boundary is NOT a
// bucket per tenant (as it is for the filesystem) but the GRANT: the control plane is the registry's authorization
// server, and a grant scoped to another workspace's namespace is never minted, so it cannot exist.
// Design: docs/architecture/managed-image-store.md

// One repository in a workspace's namespace — what `listRepositories` returns for the Settings › Images surface.
// `repository` is the full path the registry knows (`<namespace>/<name>`); `image` is the ref a spec would carry.
export const ImageRepoSchema = z.object({
  name: z.string().min(1), // the repository name inside the workspace namespace ("officeqa-env")
  repository: z.string().min(1), // "<namespace>/<name>" — the registry-side path
  image: z.string().min(1), // "<endpoint>/<namespace>/<name>" — the ref an author pins (no tag)
  tags: z.array(z.string()).optional(), // recent tags (omitted by listings that don't resolve them)
  sizeBytes: z.number().int().nonnegative().optional(),
  updatedAt: z.string().optional(), // ISO timestamp of the most recent push, when the backend reports it
});
export type ImageRepo = z.infer<typeof ImageRepoSchema>;

// One step of an image's build recipe, from the OCI image config's `history` — the registry-side answer to
// "how was this image made": each non-empty step is the Dockerfile instruction that produced a layer, and the
// metadata-only instructions (ENV/LABEL/CMD…) ride along flagged `emptyLayer`.
export const ImageBuildStepSchema = z.object({
  createdBy: z.string(), // the instruction that produced the step ("RUN apt-get install …", "COPY app /app")
  created: z.string().optional(), // ISO timestamp, when the builder recorded one
  emptyLayer: z.boolean().optional(), // true = added no layer (metadata-only instruction)
  comment: z.string().optional(),
});
export type ImageBuildStep = z.infer<typeof ImageBuildStepSchema>;

// The runtime contract baked into the image config blob — what `docker inspect` shows about how the image runs.
export const ImageRuntimeConfigSchema = z.object({
  entrypoint: z.array(z.string()).optional(),
  cmd: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(), // "KEY=value" entries, verbatim from the config
  workingDir: z.string().optional(),
  user: z.string().optional(),
  exposedPorts: z.array(z.string()).optional(), // "8080/tcp" entries
  labels: z.record(z.string(), z.string()).optional(),
});
export type ImageRuntimeConfig = z.infer<typeof ImageRuntimeConfigSchema>;

// A manifest inspect — best-effort beyond `reference`: which fields resolve depends on the manifest kind and on
// whether the config blob could be read (an index resolves through its first runnable platform's manifest).
// `digest` stays the digest of the reference AS PUSHED (the index for a multi-platform image) — that is what a
// spec pins, so inspect must never quietly substitute a child manifest's digest for it.
export const ImageInspectSchema = z.object({
  reference: z.string().min(1), // the tag or digest inspected, echoed back
  digest: z.string().optional(), // Docker-Content-Digest of the manifest — the value to pin
  mediaType: z.string().optional(), // manifest media type (image manifest vs manifest list/index)
  platforms: z.array(z.string()).optional(), // "os/arch" entries, for a manifest list / OCI index
  layerCount: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(), // sum of compressed layer sizes
  created: z.string().optional(), // ISO timestamp from the image config
  os: z.string().optional(),
  architecture: z.string().optional(),
  history: z.array(ImageBuildStepSchema).optional(), // the build recipe, oldest step first
  config: ImageRuntimeConfigSchema.optional(),
});
export type ImageInspect = z.infer<typeof ImageInspectSchema>;

// A short-lived, scope-limited authorization to pull or push — minted by the control plane, never persisted.
// ONE grant can carry MANY repository scopes (Docker Registry v2 token auth accepts repeated scopes), which is why a
// multi-service topology pulling three managed images authenticates all three with a single credential — the thing a
// per-host BYO credential structurally cannot do.
export const ImageGrantSchema = z.object({
  endpoint: z.string().min(1), // registry host[:port] the token is valid for — reachable from every execution node
  repositories: z.array(z.string().min(1)).min(1), // the repository paths this grant covers ("<namespace>/<name>")
  actions: z.array(z.enum(["pull", "push"])).min(1), // what it authorizes on those repositories
  token: z.string().min(1), // the bearer token (docker password position; username is the fixed grant user)
  expiresAt: z.string(), // ISO timestamp — grants are short-lived by construction, so revoking reach revokes pull
});
export type ImageGrant = z.infer<typeof ImageGrantSchema>;

// The docker "username" a grant is presented under. The registry ignores it (the bearer token carries the scopes);
// a value is still required because docker's basic-auth exchange sends both fields.
export const IMAGE_GRANT_USERNAME = "everdict";
