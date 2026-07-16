import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft, GitCompare } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { DeleteJudgeButton } from '@/features/delete-judge'
import {
  isRubricRef,
  judgeModelLabel,
  judgeSpecSchema,
  judgesSchema,
  type JudgeSpec,
} from '@/entities/judge'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EntityRef, ModelChip, RuntimeChip } from '@/shared/ui/chip'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/judges`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// Judge detail — meta strip (kind/ownership/version + kind-specific facts) + rubric section.
// judge.rubric has two shapes: inline text (rendered verbatim) or a registered-rubric reference (rendered as a link).
export default async function JudgeDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('judgesPage')
  const { principal, ctx } = await currentPrincipal()

  // Summary (owner/versions) from the list — back to the list if the judge doesn't exist or the connection fails.
  let summary
  try {
    summary = judgesSchema.parse(await controlPlane.listJudges(ctx)).find((j) => j.id === id)
  } catch {
    summary = undefined
  }
  if (!summary) redirect(`/${workspace}/judges`)

  const versions = sortSemverDesc(summary.versions)
  const latest = versions[0] ?? summary.versions[0] ?? 'latest'

  // Delete (versions / whole judge) — admin only (the creator exception is server-side) + workspace-owned
  // (_shared/first-party delete 404s at the control plane, so the affordance is hidden for them).
  const currentWorkspace = principal?.workspace ?? workspace
  const canDeleteJudge =
    can(principal?.roles, 'judges:delete') && summary.owner === currentWorkspace

  let judge: JudgeSpec | undefined
  let error: string | undefined
  try {
    judge = judgeSpecSchema.parse(await controlPlane.getJudge(ctx, id, latest))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!judge) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader title={id} />
        <Callout tone="danger">{t('loadError', { detail: error ? `: ${error}` : '' })}</Callout>
      </div>
    )
  }

  const rubric = judge.rubric

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader
          title={judge.id}
          description={judge.description}
          actions={
            canDeleteJudge || versions.length > 1 ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {versions.length > 1 && (
                  <Link
                    href={`/${workspace}/judges/${encodeURIComponent(judge.id)}/diff`}
                    className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                  >
                    <GitCompare className="size-3.5" />
                    {t('compareVersions')}
                  </Link>
                )}
                {canDeleteJudge && (
                  <DeleteJudgeButton
                    id={judge.id}
                    versions={[...versions].reverse()}
                    latest={latest}
                    workspace={workspace}
                    versionTags={summary.versionTags ?? {}}
                  />
                )}
              </div>
            ) : null
          }
        />
        {/* Meta strip — kind · ownership · version · kind-specific facts. Absent facts are simply not rendered. */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{judge.kind}</Badge>
          <Badge tone={summary.owner === '_shared' ? 'neutral' : 'success'}>
            {summary.owner === '_shared' ? t('sharedBadge') : t('workspaceBadge')}
          </Badge>
          <span className="font-mono text-[12px] text-faint">
            {t('latestVersion', { version: judge.version })}
          </span>
          {judge.kind === 'model' && judge.model && (
            <ModelChip>{judgeModelLabel(judge.model)}</ModelChip>
          )}
          {judge.kind === 'model' && judge.provider && (
            <code className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {judge.provider}
            </code>
          )}
          {judge.kind === 'model' && (judge.inputs?.length ?? 0) > 0 && (
            <code className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {judge.inputs?.join(', ')}
            </code>
          )}
          {judge.kind === 'model' && judge.passThreshold !== undefined && (
            <code className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              {t('passThresholdChip', { value: judge.passThreshold })}
            </code>
          )}
          {judge.kind === 'harness' && judge.harness && (
            <span className="text-[12px] text-muted-foreground">
              <EntityRef id={judge.harness.id} version={judge.harness.version} kind="harness" />
            </span>
          )}
          {judge.kind === 'harness' && judge.runtime && <RuntimeChip label={judge.runtime} />}
        </div>
      </div>

      {rubric !== undefined && (
        <section className="space-y-2.5">
          <SectionHeader title={t('rubricSection')} />
          {isRubricRef(rubric) ? (
            // Registered rubric — link to the rubric's own detail instead of freezing/inlining its text here.
            <Link
              href={`/${workspace}/rubrics/${encodeURIComponent(rubric.id)}`}
              className="inline-flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px] shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <EntityRef id={rubric.id} version={rubric.version} />
              <span className="text-[11px] text-faint">{t('rubricRefBadge')}</span>
            </Link>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {rubric}
            </pre>
          )}
        </section>
      )}

      {versions.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('versions')} />
          <div className="flex flex-wrap gap-1.5">
            {versions.map((v) => (
              <code
                key={v}
                className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
              >
                {v}
              </code>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
