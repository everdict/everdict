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
