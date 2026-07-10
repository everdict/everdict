import { z } from "zod";
import { RunnerMetaSchema } from "./runner-meta.js";

// POST /workspace/runners/github-install (core GithubRunnerInstallResult) — one admin action stands up two
// workers on a build server: a GitHub Actions self-hosted runner + an Everdict workspace-shared runner.
// The install script embeds the one-time rnr_ pairing token and the short-lived GitHub registration token —
// neither is stored by Everdict, and neither appears anywhere else in the response or in later reads.
export const GithubRunnerInstallResultSchema = z.object({
  runner: RunnerMetaSchema.describe("The newly paired workspace-shared runner"),
  runtimeTarget: z.string().describe('"self:ws:<id>" — the value for the workflow\'s runtime input'),
  githubRunnerLabel: z.string().describe('"everdict-<id>" — the label for the workflow\'s runs-on'),
  installScript: z
    .string()
    .describe("Bash to run on the build server (starts both workers). Contains one-time tokens — do not share"),
  workflowHint: z.string().describe("runs-on/runtime snippet to add to the workflow"),
  registrationExpiresAt: z.string().describe("GitHub registration token expiry (short-lived, about 1 hour)"),
});
export type GithubRunnerInstallResult = z.infer<typeof GithubRunnerInstallResultSchema>;
