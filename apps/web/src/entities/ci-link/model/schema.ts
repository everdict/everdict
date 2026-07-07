import { z } from 'zod'

// Client mirror of the control plane CI repo link (repo↔harness slot mapping = GitHub Actions OIDC trust policy).
// The web couples over HTTP only — no backend package dependency. Source: packages/db WorkspaceCiLinkSchema.

// slot → monorepo path filter (optional). The service slots this repo's CI swaps.
export const ciLinkSlotSchema = z.object({ path: z.string().optional() })
export type CiLinkSlot = z.infer<typeof ciLinkSlotSchema>

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
export type CiLink = z.infer<typeof ciLinkSchema>
export type CiTrigger = NonNullable<CiLink['trigger']>

// GET/PUT/DELETE /workspace/ci/links response — always returns the full current set of links.
export const ciLinksResponseSchema = z.object({ links: z.array(ciLinkSchema) })
export type CiLinksResponse = z.infer<typeof ciLinksResponseSchema>

// A single GET /workspace/github-app/repos row — a thinly normalized form of the GitHub repo list (picker) (bare array).
export const repoInfoSchema = z.object({
  fullName: z.string(), // "owner/name"
  host: z.string().optional(), // GHE base URL of the installation this repo belongs to — unset = github.com
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.string().optional(),
})
export type RepoInfo = z.infer<typeof repoInfoSchema>
export const reposSchema = z.array(repoInfoSchema)

// POST /workspace/ci/links/setup-pr response — the workflow setup PR opened on the target repo.
export const setupPrResultSchema = z.object({ prUrl: z.string(), branch: z.string() })
export type SetupPrResult = z.infer<typeof setupPrResultSchema>
