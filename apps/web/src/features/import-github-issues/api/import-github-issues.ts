'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import type { IssueActionResult } from '@/features/manage-issue'
import { issueSchema, issuesSchema } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// GitHub import + manual sync server actions (docs/tracker.md). Everdict is the CLIENT: nothing here polls and
// nothing subscribes to a webhook, so every refresh below is something a member asked for by pressing a button.
//
// These three shapes are served straight from the control plane's own service types and have NO
// @everdict/contracts wire DTO, so — unlike the entity schemas — they carry no drift guard. The local zod IS the
// whole boundary here, which is why every field is spelled out rather than passed through.
const importCandidateSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  author: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()).default([]),
  body: z.string().optional(),
})
const importCandidatesSchema = z.array(importCandidateSchema)

const importResultSchema = z.object({
  created: issuesSchema,
  skipped: z.array(
    z.object({ number: z.number(), reason: z.enum(['already_imported', 'pull_request']) })
  ),
})

const syncOutcomesSchema = z.array(
  z.object({
    id: z.string(),
    number: z.number(),
    changed: z.boolean(),
    error: z.string().optional(),
  })
)

export type GithubImportCandidate = z.infer<typeof importCandidateSchema>
export type GithubImportSkip = z.infer<typeof importResultSchema>['skipped'][number]
export type IssueSyncOutcome = z.infer<typeof syncOutcomesSchema>[number]

export interface ImportCandidatesResult {
  ok: boolean
  candidates?: GithubImportCandidate[]
  error?: string
}

export interface ImportIssuesResult {
  ok: boolean
  // Both halves matter: a partial import is the normal outcome (re-running the flow after a failure skips what
  // already landed), so the caller must be able to name what did NOT come across.
  created?: number
  skipped?: GithubImportSkip[]
  error?: string
}

export interface PullRepositoryResult {
  ok: boolean
  outcomes?: IssueSyncOutcome[]
  error?: string
}

function revalidateIssues(): void {
  revalidatePath('/[workspace]/issues', 'page')
  revalidatePath('/[workspace]/issues/[id]', 'page')
}

// A repo's issues minus pull requests minus the ones this workspace already holds. Reads through the workspace
// GitHub App installation, so a repo the App was not granted is the control plane's 404, surfaced verbatim.
export async function listImportCandidatesAction(input: {
  repository: string
  host?: string
  state?: 'open' | 'closed' | 'all'
}): Promise<ImportCandidatesResult> {
  const ctx = await authContext()
  try {
    const candidates = importCandidatesSchema.parse(
      await controlPlane.listIssueImportCandidates(ctx, input)
    )
    return { ok: true, candidates }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Copy the chosen numbers into the tracker. An open issue lands as `todo`; a closed one lands as `done` WITHOUT a
// scorecard, because claiming evidence we do not have would poison every later regression comparison.
export async function importGithubIssuesAction(input: {
  repository: string
  host?: string
  numbers: number[]
  projectId?: string
  sync?: { pull: boolean; push: boolean }
}): Promise<ImportIssuesResult> {
  const ctx = await authContext()
  try {
    const result = importResultSchema.parse(await controlPlane.importIssues(ctx, input))
    revalidateIssues()
    return { ok: true, created: result.created.length, skipped: result.skipped }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// The manual bulk pull for one repository. One issue's failure lands on that issue's outcome row and the batch
// continues, so a non-empty `error` in the result is per-issue news, not a failed call.
export async function pullIssueRepositoryAction(input: {
  repository: string
  host?: string
}): Promise<PullRepositoryResult> {
  const ctx = await authContext()
  try {
    const outcomes = syncOutcomesSchema.parse(await controlPlane.pullIssueRepository(ctx, input))
    revalidateIssues()
    return { ok: true, outcomes }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Refresh a single imported copy. A remote unchanged since the last pull is a no-op — the same watermark check
// that swallows the echo of our own push.
export async function pullIssueAction(id: string): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.pullIssue(ctx, id))
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setIssueGithubSyncAction(
  id: string,
  sync: { pull: boolean; push: boolean }
): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.setIssueGithubSync(ctx, id, sync))
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function detachIssueGithubAction(id: string): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.detachIssueGithub(ctx, id))
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
