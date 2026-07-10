import type {
  CiLinkRoster,
  InstallationRepo,
  SetupPrResult as WireSetupPrResult,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control plane CI repo link (repo↔harness slot mapping = GitHub Actions OIDC trust policy).
// Source: @everdict/db WorkspaceCiLinkSchema, served via the CiLinkRoster wire DTO.

// slot → monorepo path filter (optional). The service slots this repo's CI swaps.
export const ciLinkSlotSchema = z.object({ path: z.string().optional() })

// A single repo link — the "existence" of the link trusts that repo's OIDC token into this workspace (keyless CI trust).
export const ciLinkSchema = z.object({
  repository: z.string(), // "owner/name"
  host: z.string().optional(), // unset = github.com
  harness: z.string(), // harness instance id
  dataset: z.string().optional(), // dataset id the CI fires (used to generate the setup-PR workflow)
  slots: z.record(z.string(), ciLinkSlotSchema).default({}),
  createdBy: z.string(), // for audit (unrelated to fire authentication)
  disabled: z.boolean().optional(),
  runsOn: z.string().optional(), // narrowing override — workflow runs-on (default "[self-hosted]", e.g. "[self-hosted, everdict-<id>]")
  runtime: z.string().optional(), // narrowing override — run-eval runtime (default "self:ws" pool, e.g. "self:ws:<id>")
  // PR eval fire mode — auto=PR-event automatic only · comment=PR comment /evaluate only (on-demand) · unset=both
  trigger: z.enum(['auto', 'comment', 'both']).optional(),
})

// GET/PUT/DELETE /workspace/ci/links response — always returns the full current set of links.
export const ciLinksResponseSchema = z.object({ links: z.array(ciLinkSchema) })

// A single GET /workspace/github-app/repos row — a thinly normalized form of the GitHub repo list (picker) (bare array).
export const repoInfoSchema = z.object({
  fullName: z.string(), // "owner/name"
  host: z.string().optional(), // GHE base URL of the installation this repo belongs to — unset = github.com
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.string().optional(),
})
export const reposSchema = z.array(repoInfoSchema)

// POST /workspace/ci/links/setup-pr response — the workflow setup PR opened on the target repo.
export const setupPrResultSchema = z.object({ prUrl: z.string(), branch: z.string() })

// The single-link wire type sourced through the roster DTO.
type WireCiLink = CiLinkRoster['links'][number]

// Drift guards — all identical-shape (the web models every wire field and no extra). The .default({}) on `slots`
// is an input-only concern; the inferred OUTPUT is Record<string,{path?}> on both sides. RepoInfo maps to the
// wire InstallationRepo. All guard bidirectionally: a renamed/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebCiLink = z.infer<typeof ciLinkSchema>
type WebCiLinksResponse = z.infer<typeof ciLinksResponseSchema>
type WebRepoInfo = z.infer<typeof repoInfoSchema>
type WebSetupPrResult = z.infer<typeof setupPrResultSchema>
type _linkFwd = AssertAssignable<WebCiLink, WireCiLink>
type _linkBack = AssertAssignable<WireCiLink, WebCiLink>
type _rosterFwd = AssertAssignable<WebCiLinksResponse, CiLinkRoster>
type _rosterBack = AssertAssignable<CiLinkRoster, WebCiLinksResponse>
type _repoFwd = AssertAssignable<WebRepoInfo, InstallationRepo>
type _repoBack = AssertAssignable<InstallationRepo, WebRepoInfo>
type _setupPrFwd = AssertAssignable<WebSetupPrResult, WireSetupPrResult>
type _setupPrBack = AssertAssignable<WireSetupPrResult, WebSetupPrResult>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type CiLink = WireCiLink
export type CiLinkSlot = WireCiLink['slots'][string]
export type CiTrigger = NonNullable<WireCiLink['trigger']>
export type CiLinksResponse = CiLinkRoster
export type RepoInfo = InstallationRepo
export type SetupPrResult = WireSetupPrResult

export type __ciLinkDriftGuard = [
  _linkFwd,
  _linkBack,
  _rosterFwd,
  _rosterBack,
  _repoFwd,
  _repoBack,
  _setupPrFwd,
  _setupPrBack,
]
