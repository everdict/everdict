import { z } from "zod";

// Workspace GitHub App integration status (GithubAppService.GithubAppView). No secret values ever leave:
// privateKeySecretName is a SecretStore name reference (never the PEM), and installation tokens are minted
// on demand — nothing token-shaped is stored or returned here.

// A GHE App the workspace registered (the github.com App comes from operator env and is not listed here).
export const GithubAppRegistrationSchema = z.object({
  host: z.string().describe("GHE base URL the App is registered for"),
  slug: z.string().describe("App slug — used in the install URL /github-apps/{slug}/installations/new"),
  appId: z.string(),
  privateKeySecretName: z
    .string()
    .describe("SecretStore name reference — the private-key PEM value itself is never stored or returned"),
  installedAccounts: z
    .array(z.string())
    .optional()
    .describe(
      "Server-computed (re-architecture P1g): accounts installed on this registration's host (normalized host match) — present only when non-empty",
    ),
});

// A workspace-owned installation (github.com or GHE) — one per installed org.
export const GithubAppInstallationSchema = z.object({
  host: z.string().optional().describe("GHE base URL — absent = github.com"),
  installationId: z.number().int(),
  account: z.string().describe("Installed org/user login"),
  connectedBy: z.string().describe("Admin subject who linked the installation (audit only)"),
  connectedAt: z.string(),
});

export const GithubAppViewSchema = z.object({
  registrations: z.array(GithubAppRegistrationSchema),
  installations: z.array(GithubAppInstallationSchema),
});
