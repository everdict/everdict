import 'server-only'

import { membersSchema } from '@/entities/member'
import { scorecardsSchema, type ScorecardRecord } from '@/entities/scorecard'
import { viewsSchema, type View } from '@/entities/view'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export type Author = { name: string; avatarUrl?: string }

export interface AnalysisData {
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  savedViews: View[]
  subject: string
  canManage: boolean // scorecards:run — can save/edit/delete (owned) Views
  isAdmin: boolean // workspace admin — can also manage others' shared Views (control plane enforces finally)
  error?: string
}

// Server loader shared by the analysis/view screens — scorecards + runner names + saved Views + current identity/permissions in one shot.
// The scorecard list carries only the summary, so it's light. Auxiliary data (members/views) can fail without breaking the screen.
export async function loadAnalysisData(): Promise<AnalysisData> {
  const { ctx, principal } = await currentPrincipal()

  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const savedViews = await controlPlane
    .listViews(ctx)
    .then((r) => viewsSchema.parse(r))
    .catch(() => [])

  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, Author> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  return {
    scorecards,
    authors,
    savedViews,
    subject: principal?.subject ?? '',
    canManage: can(principal?.roles, 'scorecards:run'),
    isAdmin: principal?.roles.includes('admin') ?? false,
    ...(error ? { error } : {}),
  }
}
