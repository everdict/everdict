import type {
  GithubAppDetailView,
  InstallationRepo,
  InstallationWithRepos,
  InstallStartResponse,
  GithubAppRegistration as WireGithubAppRegistration,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
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

// Repositories the installation was granted access to (chosen on GitHub at install time) — GET /workspace/github-app bundles them per installation.
export const githubAppRepoSchema = z.object({
  fullName: z.string(), // "owner/name"
  host: z.string().optional(),
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.string().optional(),
})

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

// GET /workspace/github-app response — registrations + installations + the callbackUrl to register via the App Setup URL.
export const githubAppViewSchema = z.object({
  registrations: z.array(githubAppRegistrationSchema),
  installations: z.array(githubAppInstallationSchema),
  callbackUrl: z.string().optional(),
})

// POST /workspace/github-app/install/start — the GitHub App install URL to send the browser to.
export const githubAppInstallStartSchema = z.object({ installUrl: z.string() })

// Drift guards — all identical-shape (int()-branded installationId still infers `number`), so all guard
// bidirectionally. NOTE the wire mapping: the web installation (which carries repos/reposError) maps to the
// wire InstallationWithRepos (not the bare GithubAppInstallation), the web repo maps to InstallationRepo, and
// the web view maps to GithubAppDetailView (registrations + installations-with-repos + callbackUrl).
type AssertAssignable<A extends B, B> = A
type WebGithubAppRegistration = z.infer<typeof githubAppRegistrationSchema>
type WebGithubAppRepo = z.infer<typeof githubAppRepoSchema>
type WebGithubAppInstallation = z.infer<typeof githubAppInstallationSchema>
type WebGithubAppView = z.infer<typeof githubAppViewSchema>
type WebGithubAppInstallStart = z.infer<typeof githubAppInstallStartSchema>
type _registrationFwd = AssertAssignable<WebGithubAppRegistration, WireGithubAppRegistration>
type _registrationBack = AssertAssignable<WireGithubAppRegistration, WebGithubAppRegistration>
type _repoFwd = AssertAssignable<WebGithubAppRepo, InstallationRepo>
type _repoBack = AssertAssignable<InstallationRepo, WebGithubAppRepo>
type _installationFwd = AssertAssignable<WebGithubAppInstallation, InstallationWithRepos>
type _installationBack = AssertAssignable<InstallationWithRepos, WebGithubAppInstallation>
type _viewFwd = AssertAssignable<WebGithubAppView, GithubAppDetailView>
type _viewBack = AssertAssignable<GithubAppDetailView, WebGithubAppView>
type _installStartFwd = AssertAssignable<WebGithubAppInstallStart, InstallStartResponse>
type _installStartBack = AssertAssignable<InstallStartResponse, WebGithubAppInstallStart>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type GithubAppRegistration = WireGithubAppRegistration
export type GithubAppRepo = InstallationRepo
export type GithubAppInstallation = InstallationWithRepos
export type GithubAppView = GithubAppDetailView
export type GithubAppInstallStart = InstallStartResponse

export type __githubAppDriftGuard = [
  _registrationFwd,
  _registrationBack,
  _repoFwd,
  _repoBack,
  _installationFwd,
  _installationBack,
  _viewFwd,
  _viewBack,
  _installStartFwd,
  _installStartBack,
]
