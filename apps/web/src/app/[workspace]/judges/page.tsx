import Link from 'next/link'
import { Gavel } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { judgesSchema } from '@/entities/judge'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Judges — Agent Judges (model | harness), workspace-owned + shared defaults.
export default async function JudgesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('judgesPage')
  const { principal, ctx } = await currentPrincipal()

  let error: string | undefined
  let judges = judgesSchema.parse([])
  try {
    judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const currentWorkspace = principal?.workspace ?? workspace

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
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
              href={`/${workspace}/judges/${encodeURIComponent(j.id)}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
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
              <Badge tone={j.owner === currentWorkspace ? 'success' : 'neutral'}>
                {j.owner === currentWorkspace ? t('workspaceBadge') : t('sharedBadge')}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
