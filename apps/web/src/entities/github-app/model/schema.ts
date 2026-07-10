import { z } from 'zod'

// Client mirror of the control plane GET /workspace/github-app response — workspace-owned GitHub App integration.
// No secrets: privateKeySecretName is a SecretStore name reference, not the value; installation tokens are minted on-demand so not stored.

// GHE App registration (github.com comes from operator env → not here). An admin registers once per workspace.
export const githubAppRegistrationSchema = z.object({
  host: z.string(),
  slug: z.string(),
  appId: z.string(),
  privateKeySecretName: z.string(),
  // Server-computed (P1g): accounts installed on this host (normalized match) — replaces the deleted sameHost mirror.
  installedAccounts: z.array(z.string()).optional(),
})
export type GithubAppRegistration = z.infer<typeof githubAppRegistrationSchema>

// Repositories the installation was granted access to (chosen on GitHub at install time) — GET /workspace/github-app bundles them per installation.
export const githubAppRepoSchema = z.object({
  fullName: z.string(), // "owner/name"
  host: z.string().optional(),
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.string().optional(),
})
export type GithubAppRepo = z.infer<typeof githubAppRepoSchema>

// Workspace-owned installation (github.com + GHE). One per installed org.
// repos/reposError are per-installation soft-fail — the installation record is shown even if the lookup fails.
export const githubAppInstallationSchema = z.object({
  host: z.string().optional(), // unset = github.com
  installationId: z.number(),
  account: z.string(), // installed org/user login
  connectedBy: z.string(),
  connectedAt: z.string(),
  repos: z.array(githubAppRepoSchema).optional(), // list of allowed repositories
  reposError: z.string().optional(), // human-readable message when the lookup fails
})
export type GithubAppInstallation = z.infer<typeof githubAppInstallationSchema>

// GET /workspace/github-app response — registrations + installations + the callbackUrl to register via the App Setup URL.
export const githubAppViewSchema = z.object({
  registrations: z.array(githubAppRegistrationSchema),
  installations: z.array(githubAppInstallationSchema),
  callbackUrl: z.string().optional(),
})
export type GithubAppView = z.infer<typeof githubAppViewSchema>

// POST /workspace/github-app/install/start — the GitHub App install URL to send the browser to.
export const githubAppInstallStartSchema = z.object({ installUrl: z.string() })
export type GithubAppInstallStart = z.infer<typeof githubAppInstallStartSchema>
