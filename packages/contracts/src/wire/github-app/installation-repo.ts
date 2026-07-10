import { z } from "zod";

// One repo-picker row — a thin normalization of GitHub's GET /installation/repositories
// (GithubAppService.InstallationRepo). Only the repos chosen at install time appear
// (= exactly what the team explicitly allowed the App to access).
export const InstallationRepoSchema = z.object({
  fullName: z.string().describe('Repository "owner/name"'),
  host: z.string().optional().describe("GHE base URL of the installation this repo belongs to — absent = github.com"),
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.string().optional().describe("Last push timestamp (only when GitHub reports one)"),
});
export type InstallationRepo = z.infer<typeof InstallationRepoSchema>;
