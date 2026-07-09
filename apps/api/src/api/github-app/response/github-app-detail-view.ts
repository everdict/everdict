import { z } from "zod";
import { GithubAppInstallationSchema, GithubAppRegistrationSchema } from "./github-app-view.js";
import { InstallationRepoSchema } from "./installation-repo.js";

// GET /workspace/github-app — install status with each installation's allowed repos bundled
// (GithubAppService.GithubAppDetailView + callbackUrl). Repo lookup is per-install soft-fail:
// one install's credential/network problem yields reposError on that entry instead of failing the screen.
export const InstallationWithReposSchema = GithubAppInstallationSchema.extend({
  repos: z
    .array(InstallationRepoSchema)
    .optional()
    .describe("Repos this installation may access (only the ones chosen at install time)"),
  reposError: z
    .string()
    .optional()
    .describe("Repo lookup failed for this installation (soft-fail — the install record itself is still shown)"),
});

export const GithubAppDetailViewSchema = z.object({
  registrations: z.array(GithubAppRegistrationSchema),
  installations: z.array(InstallationWithReposSchema),
  callbackUrl: z
    .string()
    .optional()
    .describe("The URL to register as the GitHub App Setup URL (present when the server can derive its public base)"),
});
