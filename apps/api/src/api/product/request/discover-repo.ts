import { z } from "zod";

// POST /products/discover — read ONE repository so the product wizard can offer choices instead of a form.
// Read-only and persists nothing: the body names a repository the workspace's GitHub App can reach, and the
// response is the evidence (published version streams + the deployable units in the tree + proposed service
// rows) a member ticks through. `host` is the GitHub Enterprise deployment, absent = github.com — the same
// convention `ProductService` and `WorkspaceCiLink` use.
export const DiscoverRepoBodySchema = z.object({
  repository: z.string().min(1).max(200), // "owner/name"
  host: z.string().min(1).max(200).optional(),
});
export type DiscoverRepoBody = z.infer<typeof DiscoverRepoBodySchema>;
