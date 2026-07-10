import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { VersionTagsEditor } from '@/features/version-tags'
import { rubricSpecSchema, rubricsSchema, type RubricSpec } from '@/entities/rubric'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/rubrics`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

function PreBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
      {children}
    </pre>
  )
}

// Rubric detail — meta strip + content sections (text / criteria table / prompt template).
// Empty sections are hidden entirely (detail-view convention: no "none" placeholders).
export default async function RubricDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('rubricsPage')
  const { principal, ctx } = await currentPrincipal()

  // Summary (owner/versions) from the list — back to the list if the rubric doesn't exist or the connection fails.
  let summary
  try {
    summary = rubricsSchema.parse(await controlPlane.listRubrics(ctx)).find((r) => r.id === id)
  } catch {
    summary = undefined
  }
  if (!summary) redirect(`/${workspace}/rubrics`)

  const versions = sortSemverDesc(summary.versions)
  const latest = versions[0] ?? summary.versions[0] ?? 'latest'

  let rubric: RubricSpec | undefined
  let error: string | undefined
  try {
    rubric = rubricSpecSchema.parse(await controlPlane.getRubric(ctx, id, latest))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!rubric) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader title={id} />
        <Callout tone="danger">{t('loadError', { detail: error ? `: ${error}` : '' })}</Callout>
      </div>
    )
  }

  const criteria = rubric.criteria ?? []
  const tags = rubric.tags ?? []
  const hasThreshold = criteria.some((c) => c.passThreshold !== undefined)

  // This version's tags (shown = latest) (free-form labels) — same gate as registration (judges:write reuse) + editable only in the owning workspace.
  const currentWorkspace = principal?.workspace ?? workspace
  const canEditTags = can(principal?.roles, 'judges:write') && summary.owner === currentWorkspace
  const latestTags = summary.versionTags?.[latest] ?? []

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader title={rubric.id} description={rubric.description} />
        {/* Meta strip — ownership · latest version · criteria count · tags. Absent facts are simply not rendered. */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={summary.owner === '_shared' ? 'neutral' : 'success'}>
            {summary.owner === '_shared' ? t('sharedBadge') : t('workspaceBadge')}
          </Badge>
          <span className="font-mono text-[12px] text-faint">
            {t('latestVersion', { version: latest })}
          </span>
          {criteria.length > 0 && (
            <code className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {t('criteriaCount', { count: criteria.length })}
            </code>
          )}
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {rubric.text && (
        <section className="space-y-2.5">
          <SectionHeader title={t('textSection')} />
          <PreBlock>{rubric.text}</PreBlock>
        </section>
      )}

      {criteria.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('criteriaSection')} />
          <Table>
            <THead>
              <TR>
                <TH>{t('criterionId')}</TH>
                <TH>{t('criterionDescription')}</TH>
                <TH className="text-right">{t('criterionWeight')}</TH>
                {hasThreshold && <TH className="text-right">{t('criterionPassThreshold')}</TH>}
              </TR>
            </THead>
            <TBody>
              {criteria.map((c) => (
                <TR key={c.id}>
                  <TD className="font-mono text-[12px]">{c.id}</TD>
                  <TD className="text-muted-foreground">{c.description}</TD>
                  <TD className="text-right font-mono tabular-nums">{c.weight}</TD>
                  {hasThreshold && (
                    <TD className="text-right font-mono tabular-nums">
                      {c.passThreshold !== undefined ? c.passThreshold : '—'}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      )}

      {rubric.promptTemplate && (
        <section className="space-y-2.5">
          <SectionHeader title={t('promptTemplateSection')} />
          <PreBlock>{rubric.promptTemplate}</PreBlock>
        </section>
      )}

      {/* This version's tags (shown = latest) — free-form labels for distinguishing versions, separate from the spec's own content tags in the meta strip.
          If not editable and there are no tags, hide the section entirely (don't render empty sections). */}
      {(canEditTags || latestTags.length > 0) && (
        <section className="space-y-2.5">
          <SectionHeader title={t('versionTags')} />
          <VersionTagsEditor
            entity="rubric"
            id={id}
            version={latest}
            tags={latestTags}
            canEdit={canEditTags}
          />
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
