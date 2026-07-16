import { z } from "zod";

// Workspace GitHub App integration status (GithubAppService.GithubAppView). No secret values ever leave:
// installation tokens are minted on demand from the operator-env App private key — nothing token-shaped is
// stored or returned here.

// Which App install targets the operator configured (env) — github.com and/or one GitHub Enterprise host.
// Both are operator env now (GITHUB_APP_* / GITHUB_ENTERPRISE_APP_*); the admin just installs + picks repos.
export const GithubAppProvidersSchema = z.object({
  githubCom: z.boolean().describe("github.com App configured via operator env (GITHUB_APP_*) — install available"),
  enterprise: z
    .object({ host: z.string().describe("GitHub Enterprise base URL configured via operator env") })
    .optional()
    .describe(
      "GitHub Enterprise App configured via operator env (GITHUB_ENTERPRISE_APP_*) — install available when present",
    ),
});
export type GithubAppProviders = z.infer<typeof GithubAppProvidersSchema>;

// A workspace-owned installation (github.com or GHE) — one per installed org.
export const GithubAppInstallationSchema = z.object({
  host: z.string().optional().describe("GHE base URL — absent = github.com"),
  installationId: z.number().int(),
  account: z.string().describe("Installed org/user login"),
  connectedBy: z.string().describe("Admin subject who linked the installation (audit only)"),
  connectedAt: z.string(),
});
export type GithubAppInstallation = z.infer<typeof GithubAppInstallationSchema>;

export const GithubAppViewSchema = z.object({
  installations: z.array(GithubAppInstallationSchema),
  providers: GithubAppProvidersSchema,
});
export type GithubAppView = z.infer<typeof GithubAppViewSchema>;
