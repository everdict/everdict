import { z } from 'zod'

// What a self-hosted runner can support — mirror of the control plane core vocabulary (CAPABILITY_DEFS). The runner self-probes and advertises.
export const runnerCapabilities = [
  'git',
  'docker',
  'browser',
  'computer-use',
  'sandbox',
  'codex-login',
  'claude-login',
] as const
export const runnerCapabilitySchema = z.enum(runnerCapabilities)
export type RunnerCapability = z.infer<typeof runnerCapabilitySchema>

// capability kind — badge meaning (the enforcement layer differs). Mirror of core CapabilityKind.
export type CapabilityKind = 'functional' | 'security' | 'auth'

// display meta (name·kind·label) — used for the runner card's green (supported)/grey (unsupported) badges. Core vocabulary order.
export const capabilityMeta: { name: RunnerCapability; kind: CapabilityKind; label: string }[] = [
  { name: 'git', kind: 'functional', label: 'Git' },
  { name: 'docker', kind: 'functional', label: 'Docker' },
  { name: 'browser', kind: 'functional', label: 'Browser' },
  { name: 'computer-use', kind: 'functional', label: 'Computer-use' },
  { name: 'sandbox', kind: 'security', label: 'Sandbox' },
  { name: 'codex-login', kind: 'auth', label: 'Codex login' },
  { name: 'claude-login', kind: 'auth', label: 'Claude login' },
]

// Mirror of GET /runners runner meta — no token (the pairing token is shown once at pairing, stored as a hash).
export const runnerMetaSchema = z.object({
  id: z.string(),
  label: z.string(),
  os: z.string().optional(),
  capabilities: z.array(z.string()),
  pairedAt: z.string(),
  lastSeenAt: z.string().optional(),
})
export type RunnerMeta = z.infer<typeof runnerMetaSchema>

// GET /runners — my runner list (personally owned; account page).
export const runnersResponseSchema = z.object({ runners: z.array(runnerMetaSchema) })
export type RunnersResponse = z.infer<typeof runnersResponseSchema>

// Mirror of POST /runners request — owner/workspace are filled by the control plane from the Principal.
export const pairRunnerInputSchema = z.object({
  label: z.string().min(1).max(80),
  os: z.string().min(1).max(40).optional(),
  capabilities: z.array(runnerCapabilitySchema).optional(),
})
export type PairRunnerInput = z.infer<typeof pairRunnerInputSchema>

// POST /runners response — the plaintext token (rnr_…) is exposed here only once (never shown again).
export const pairedRunnerSchema = z.object({ runner: runnerMetaSchema, token: z.string() })
export type PairedRunner = z.infer<typeof pairedRunnerSchema>

// POST /workspace/runners/github-install response — an install script that stands up a GitHub runner + Everdict runner together on the build server.
// installScript contains plaintext tokens (rnr_ + GitHub registration token), exposed only once.
export const githubRunnerInstallSchema = z.object({
  runner: runnerMetaSchema,
  runtimeTarget: z.string(), // self:ws:<id> — workflow runtime input value
  githubRunnerLabel: z.string(), // everdict-<id> — workflow runs-on label
  installScript: z.string(),
  workflowHint: z.string(),
  registrationExpiresAt: z.string(),
})
export type GithubRunnerInstall = z.infer<typeof githubRunnerInstallSchema>
