import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import {
  ReleaseActionsMenu,
  ReleaseComponentsEditor,
  ReleaseStatusControl,
} from '@/features/manage-product'
import { issueHref, issuePageSchema, IssueStatusBadge } from '@/entities/issue'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import {
  productDetailSchema,
  productHref,
  releaseDetailSchema,
  ReleaseStatusBadge,
  type ProductDetail,
  type ReleaseDetail,
} from '@/entities/product'
import { TrackerHistory } from '@/entities/tracker-history'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtPct } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

// A series verdict → a catalog key (the release gate vocabulary verbatim)
const VERDICT_LABEL_KEY = {
  pass: 'verdictPass',
  no_baseline: 'verdictNoBaseline',
  block: 'verdictBlock',
  blocked_missing: 'verdictBlockedMissing',
  not_comparable: 'verdictNotComparable',
  not_evaluated: 'verdictNotEvaluated',
  bootstrap_required: 'verdictBootstrapRequired',
  scope_invalid: 'verdictScopeInvalid',
  contract_stale: 'verdictContractStale',
  contract_unverifiable: 'verdictContractUnverifiable',
} as const

export const dynamic = 'force-dynamic'

// The release detail — the screen that answers "may this ship". Readiness (open linked issues plus each watch series' newest against the
// previous ship's baseline) is derived and sent down by the server, and the gate control acts on top of that answer. No measurement is not a regression.
export default async function ReleasePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('releasePage')
  const { principal, ctx } = await currentPrincipal()

  let release: ReleaseDetail
  try {
    release = releaseDetailSchema.parse(await controlPlane.getRelease(ctx, id))
  } catch {
    notFound()
  }
  // The edit dialog's series choices plus the composition editor's service/version choices — only what the product DECLARED (a key that does
  // not exist is a 400, and a version not in the ledger joins to no row). The screen renders even on failure.
  let product: ProductDetail | undefined
  try {
    product = productDetailSchema.parse(await controlPlane.getProduct(ctx, release.productId))
  } catch {
    product = undefined
  }

  // The issues linked to this release — one reverse query. The same grounds as the gate's openIssues.
  const linkedIssues = await controlPlane
    .listIssues(ctx, { linkType: 'release', linkId: id, limit: 50 })
    .then((raw) => issuePageSchema.parse(raw).items)
    .catch(() => [])
  let members: Member[] = []
  try {
    members = membersSchema.parse(await controlPlane.listMembers(ctx))
  } catch {
    members = []
  }
  const actors = memberDirectoryOf(members)

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  const readiness = release.readiness

  return (
    <div className="@container space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            {release.name}
            <ReleaseStatusBadge status={release.status} />
          </span>
        }
        description={release.description}
        actions={
          canWrite ? (
            <div className="flex items-center gap-2">
              <ReleaseStatusControl releaseId={release.id} status={release.status} />
              <ReleaseActionsMenu
                workspace={workspace}
                release={release}
                seriesOptions={(product?.series ?? []).map((s) => ({ key: s.key, label: s.label }))}
              />
            </div>
          ) : null
        }
      />

      <p className="text-sm">
        <Link
          href={productHref(workspace, release.productId)}
          className="text-muted-foreground hover:text-foreground"
        >
          ← {t('backToProduct')}
        </Link>
      </p>

      {/* The readiness card — exactly what the gate sees: the open issue count and each series' newest against its baseline. */}
      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('readinessHeading')}</h2>
          {readiness.ready ? (
            <Badge tone="success">{t('ready')}</Badge>
          ) : (
            <Badge tone="warning">{t('notReady')}</Badge>
          )}
          {release.targetDate && (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {t('target', { date: release.targetDate })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={readiness.openIssues > 0 ? 'danger' : 'outline'}>
            {t('openIssues', { count: readiness.openIssues })}
          </Badge>
          {readiness.regressedSeries.length > 0 && (
            <Badge tone="danger">
              {t('regressedSeries', { count: readiness.regressedSeries.length })}
            </Badge>
          )}
        </div>
        {readiness.series.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1 font-[510]">{t('seriesColumn')}</th>
                  <th className="px-2 py-1 font-[510]">{t('latestColumn')}</th>
                  <th className="px-2 py-1 font-[510]">{t('baselineColumn')}</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {readiness.series.map((series) => (
                  <tr key={series.key} className="border-t border-border/60">
                    <td className="px-2 py-1.5 font-[510]">{series.label}</td>
                    <td className="px-2 py-1.5 font-mono">
                      {series.latest ? (
                        <Link
                          href={`/${workspace}/scorecard/${series.latest.scorecardId}`}
                          className="hover:text-primary hover:underline"
                        >
                          {series.latest.passRate !== undefined
                            ? fmtPct(series.latest.passRate)
                            : '—'}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{t('notRunYet')}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono">
                      {series.baseline ? (
                        <Link
                          href={`/${workspace}/scorecard/${series.baseline.scorecardId}`}
                          className="hover:text-primary hover:underline"
                        >
                          {series.baseline.passRate !== undefined
                            ? fmtPct(series.baseline.passRate)
                            : '—'}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{t('noBaseline')}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {/* The per-series release verdict — the scorecard gate's vocabulary. Blocking is danger, passing is success. */}
                      <Badge
                        tone={
                          series.regressed
                            ? 'danger'
                            : series.verdict === 'pass'
                              ? 'success'
                              : 'outline'
                        }
                        title={series.reasons?.join('\n')}
                      >
                        {t(VERDICT_LABEL_KEY[series.verdict])}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {product !== undefined && product.services.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('componentsHeading')} />
          <p className="text-xs text-muted-foreground">{t('componentsHint')}</p>
          <ReleaseComponentsEditor
            releaseId={release.id}
            services={product.services}
            versions={product.versions}
            {...(release.components !== undefined ? { components: release.components } : {})}
            canEdit={canWrite && release.status === 'planned'}
          />
        </section>
      )}

      {linkedIssues.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('linkedIssuesHeading')} />
          <ul className="space-y-1">
            {linkedIssues.map((issue) => (
              <li key={issue.id} className="flex items-center gap-2 text-sm">
                <Link
                  href={issueHref(workspace, issue.identifier, issue.title)}
                  className="font-mono text-xs text-muted-foreground hover:text-foreground"
                >
                  {issue.identifier}
                </Link>
                <span className="truncate">{issue.title}</span>
                <span className="ml-auto shrink-0">
                  <IssueStatusBadge status={issue.status} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {release.history.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('historyHeading')} />
          <TrackerHistory
            kind="project"
            subject={t('subject')}
            entries={release.history}
            actors={actors}
            workspace={workspace}
          />
        </section>
      )}
    </div>
  )
}
