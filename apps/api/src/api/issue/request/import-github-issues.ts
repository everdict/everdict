import { z } from "zod";

// Direction toggles for an imported copy. Pull defaults on (a copy that never refreshes is a stale copy);
// push defaults OFF because closing someone else's GitHub issue must be a deliberate choice.
export const IssueGithubSyncBodySchema = z.object({
  pull: z.boolean(),
  push: z.boolean(),
});

export const ImportGithubIssuesBodySchema = z.object({
  repository: z.string().min(1).max(200), // "owner/name"
  host: z.string().min(1).max(200).optional(), // unset = github.com
  numbers: z.array(z.number().int().positive()).min(1).max(100),
  projectId: z.string().min(1).max(200).optional(),
  sync: IssueGithubSyncBodySchema.optional(),
});

// The manual bulk pull over one repo's sync-enabled copies.
export const PullGithubIssuesBodySchema = z.object({
  repository: z.string().min(1).max(200),
  host: z.string().min(1).max(200).optional(),
});
