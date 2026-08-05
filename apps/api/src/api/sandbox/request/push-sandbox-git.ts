import { z } from "zod";

// Push a world session's working tree to its remote (agent worlds W2). Committing is the caller's own job
// through exec — it needs no credential; authenticating the push is the one thing a container cannot do for
// itself, so that is all this does (optionally opening a pull request for the pushed branch).
export const PushSandboxGitBodySchema = z.object({
  dir: z.string().min(1).max(512).optional(), // default: the directory the session cloned into ("work")
  branch: z.string().min(1).max(255).optional(), // default: the working tree's current branch
  remote: z.string().min(1).max(255).optional(), // default: "origin"
  pullRequest: z.object({ title: z.string().min(1).max(300), body: z.string().max(60_000).optional() }).optional(), // present = open a PR for the pushed branch against the repo's default branch
});
export type PushSandboxGitBody = z.infer<typeof PushSandboxGitBodySchema>;
