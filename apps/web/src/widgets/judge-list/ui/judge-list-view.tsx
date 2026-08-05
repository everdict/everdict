import { Gavel } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import { DeleteJudgeRowButton } from '@/features/delete-judge'
import { judgesSchema } from '@/entities/judge'
import type { TeamWithSummary } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

// Agent Judges (model | harness) — workspace-owned + shared defaults. ONE component behind TWO addresses:
// `/{workspace}/judges` 와 `/{workspace}/teams/ENG/judges`. 하네스·데이터셋과 같은 규칙이다.
export async function JudgeListView({
  workspace,
  team,
}: {
  workspace: string
  team?: TeamWithSummary
}) {
  const t = await getTranslations('judgesPage')
  const { principal, ctx } = await currentPrincipal()

  let error: string | undefined
  let judges = judgesSchema.parse([])
  try {
    judges = judgesSchema.parse(await controlPlane.listJudges(ctx, team?.id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const currentWorkspace = principal?.workspace ?? workspace
  // Delete = admin only (the creator exception is server-side); the affordance shows only on workspace-owned judges
  // (_shared/first-party delete 404s at the control plane).
  const canDeleteJudges = can(principal?.roles, 'judges:delete')
  const scope: TeamScope | undefined = team ? { workspace, team, section: 'judges' } : undefined

  return (
    <div className="space-y-6">
      {scope && <TeamScopeBar scope={scope} />}
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          // 하네스·데이터셋과 같다 — 팀 주소에서도 같은 워크스페이스 폼으로 간다.
          can(principal?.roles, 'judges:write') ? (
            <Link href={`/${workspace}/judges/new`} className={buttonVariants({ size: 'sm' })}>
              {t('register')}
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : judges.length === 0 ? (
        <EmptyState
          icon={<Gavel strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {judges.map((j) => (
            <Link
              key={j.id}
              href={`/${workspace}/judge/${encodeURIComponent(j.id)}`}
              className="group flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                  <Gavel className="size-[18px]" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="truncate font-mono text-[13px] font-[560] text-foreground">
                    {j.id}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {j.versions.map((v) => (
                      <code
                        key={v}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={j.owner === currentWorkspace ? 'success' : 'neutral'}>
                  {j.owner === currentWorkspace ? t('workspaceBadge') : t('sharedBadge')}
                </Badge>
                {canDeleteJudges && j.owner === currentWorkspace && (
                  <DeleteJudgeRowButton
                    id={j.id}
                    versions={[...sortSemverDesc(j.versions)].reverse()}
                    latest={sortSemverDesc(j.versions)[0] ?? j.versions[0] ?? ''}
                    workspace={workspace}
                    versionTags={j.versionTags ?? {}}
                  />
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
