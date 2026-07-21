import type {
  GithubRunnerInstallResult,
  PairedRunnerResponse,
  RunnerRoster,
  RunnerMeta as WireRunnerMeta,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.

// What a self-hosted runner can support — mirror of the control plane core vocabulary (CAPABILITY_DEFS). The runner self-probes and advertises.
// The wire types `capabilities` as a loose `string[]`; these display types (RunnerCapability/CapabilityKind/
// capabilityMeta) are a web-only narrower vocabulary with no contract counterpart — they stay LOCAL.
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
  version: z.string().optional(), // runner build/app version (self-reported on lease)
  protocol: z.number().int().optional(), // runner protocol version (self-reported on lease)
  updateRequired: z.boolean().optional(), // derived by the control plane: this runner is behind the server → update it
  // Live self-reported status (overlaid by the control plane, never stored) — why the runner can/can't do work now.
  status: z
    .object({ text: z.string(), level: z.enum(['info', 'warn', 'error']), at: z.string() })
    .optional(),
})

// GET /runners — my runner list (personally owned; account page).
export const runnersResponseSchema = z.object({ runners: z.array(runnerMetaSchema) })

// Mirror of POST /runners request — owner/workspace are filled by the control plane from the Principal. Request DTO — no response counterpart, stays local.
export const pairRunnerInputSchema = z.object({
  label: z.string().min(1).max(80),
  os: z.string().min(1).max(40).optional(),
  capabilities: z.array(runnerCapabilitySchema).optional(),
})
export type PairRunnerInput = z.infer<typeof pairRunnerInputSchema>

// POST /runners response — the plaintext token (rnr_…) is exposed here only once (never shown again).
// attachCommand: server-authored `everdict runner --pair …` (host that has everdict); installCommand: the
// `curl … | sh` one-liner that installs the binary AND pairs (host that doesn't). Both headless-only.
export const pairedRunnerSchema = z.object({
  runner: runnerMetaSchema,
  token: z.string(),
  attachCommand: z.string().optional(),
  installCommand: z.string().optional(),
})

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

// Drift guards — all identical-shape (meta = every wire field; roster/paired/github-install match their DTOs),
// so the guards are bidirectional: a renamed/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebRunnerMeta = z.infer<typeof runnerMetaSchema>
type WebRunnersResponse = z.infer<typeof runnersResponseSchema>
type WebPairedRunner = z.infer<typeof pairedRunnerSchema>
type WebGithubRunnerInstall = z.infer<typeof githubRunnerInstallSchema>
type _metaFwd = AssertAssignable<WebRunnerMeta, WireRunnerMeta>
type _metaBack = AssertAssignable<WireRunnerMeta, WebRunnerMeta>
type _rosterFwd = AssertAssignable<WebRunnersResponse, RunnerRoster>
type _rosterBack = AssertAssignable<RunnerRoster, WebRunnersResponse>
type _pairedFwd = AssertAssignable<WebPairedRunner, PairedRunnerResponse>
type _pairedBack = AssertAssignable<PairedRunnerResponse, WebPairedRunner>
type _installFwd = AssertAssignable<WebGithubRunnerInstall, GithubRunnerInstallResult>
type _installBack = AssertAssignable<GithubRunnerInstallResult, WebGithubRunnerInstall>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type RunnerMeta = WireRunnerMeta
export type RunnersResponse = RunnerRoster
export type PairedRunner = PairedRunnerResponse
export type GithubRunnerInstall = GithubRunnerInstallResult

export type __runnerDriftGuard = [
  _metaFwd,
  _metaBack,
  _rosterFwd,
  _rosterBack,
  _pairedFwd,
  _pairedBack,
  _installFwd,
  _installBack,
]
