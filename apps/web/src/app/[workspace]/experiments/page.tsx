import { getTranslations } from 'next-intl/server'
import { z } from 'zod'

import { judgesSchema } from '@/entities/judge'
import { ScoreGroupButton } from '@/features/score-group'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// The list shape only — a group IS a scorecard row and the detail page for one is `/scorecard/:id`, so
// mirroring the whole record here would be a second reader of the same thing.
const groupListSchema = z.array(
  z
    .object({
      id: z.string(),
      status: z.string(),
      dataset: z.object({ id: z.string(), version: z.string() }).optional(),
      harness: z.object({ id: z.string(), version: z.string() }).optional(),
      createdAt: z.string(),
    })
    .passthrough()
)

// ── THE TWO-PHASE EXPERIMENT ───────────────────────────────────────────────────────────────────────
//
// Phase 1 runs UNGRADED; phase 2 applies judges over the runs that already exist and never re-executes
// them. That split is what makes it cheap to ask a second question of the same compute — and it had no web
// surface at all, so only an agent could ask the second question.
// docs/architecture/web-runtime-gap-census-spec.md
export default async function ExperimentsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('experimentsPage')
  const ctx = await authContext()

  let groups: z.infer<typeof groupListSchema> = []
  let judges: { id: string; versions: string[] }[] = []
  let error: string | undefined
  try {
    groups = groupListSchema.parse(await controlPlane.listGroups(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  try {
    judges = judgesSchema.parse(await controlPlane.listJudges(ctx)).map((j) => ({
      id: j.id,
      versions: j.versions,
    }))
  } catch {
    // Best-effort: without the judge list the page still lists the experiments, and the score control says
    // so itself rather than offering an empty picker.
    judges = []
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('title')} description={t('description')} />
      {error !== undefined && <Callout tone="danger">{t('loadError', { error })}</Callout>}
      {error === undefined && groups.length === 0 && <EmptyState title={t('empty')} />}
      {groups.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {groups.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <Badge tone={g.status === 'succeeded' ? 'success' : g.status === 'failed' ? 'danger' : 'neutral'}>
                {g.status}
              </Badge>
              {/* A group IS a scorecard row, so its detail is the scorecard page — a second detail view
                  would be two readers of one record. */}
              <Link href={`/${workspace}/scorecard/${encodeURIComponent(g.id)}`} className="font-mono text-[12.5px]">
                {g.id}
              </Link>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                {g.dataset ? `${g.dataset.id}@${g.dataset.version}` : ''}
                {g.harness ? ` · ${g.harness.id}@${g.harness.version}` : ''}
              </span>
              <span className="shrink-0 text-[11px] text-faint">{g.createdAt}</span>
              <ScoreGroupButton id={g.id} judges={judges} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
