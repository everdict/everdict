import Link from 'next/link'
import {
  BarChart3,
  BookText,
  Boxes,
  ChevronLeft,
  Clock,
  Database,
  ExternalLink,
  FileText,
  GitBranchPlus,
  GitCompare,
  History,
  Scale,
  ScrollText,
  Tags,
  Trophy,
  Users,
  Waypoints,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'

import { VersionSwitcher } from '@/features/dataset-versions'
import { CommentsSection } from '@/features/discuss'
import { ActivityTimeline, type ActivityItem, type Actor } from '@/features/discuss-dataset'
import { CaseList } from '@/features/inspect-dataset'
import { VersionTagsEditor } from '@/features/version-tags'
import {
  datasetSchema,
  datasetsSchema,
  type Dataset,
  type DatasetProvenance,
  type DatasetSummary,
} from '@/entities/dataset'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildDatasetRelations } from '@/shared/lib/dataset-relations'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EnvBadge, GraderBadge } from '@/shared/ui/case-badges'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/datasets`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

export default async function DatasetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ version?: string }>
}) {
  const { workspace, id } = await params
  const { version } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('datasetsPage')

  // All versions this dataset has (newest first) + list meta (creator·created/updated time) — used by the version switcher/diff/header.
  let versions: string[] = []
  let summary: DatasetSummary | undefined
  try {
    summary = datasetsSchema.parse(await controlPlane.listDatasets(ctx)).find((d) => d.id === id)
    if (summary) versions = sortSemverDesc(summary.versions)
  } catch {
    versions = []
  }

  // Related harnesses (derived from scorecards) + creator name (members join) — supplementary info; the detail view still renders even if it fails.
  const scorecards = await controlPlane
    .listScorecards(ctx)
    .then((r) => scorecardsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const relation = buildDatasetRelations(scorecards)[id]
  const currentWorkspace = principal?.workspace ?? workspace
  // Creator — profile name+avatar (if any). Seed/_shared are shown as first-party (no avatar).
  const author = (() => {
    if (!summary?.createdBy) {
      return {
        name: summary && summary.owner !== currentWorkspace ? 'first-party' : '—',
        known: false,
      }
    }
    const m = members.find((x) => x.subject === summary?.createdBy)
    return {
      name: m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(summary.createdBy),
      ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      known: true,
    }
  })()
  // Edit = deploy a new version — only for datasets owned by this workspace (shared/first-party excluded).
  const canPublish = can(principal?.roles, 'datasets:write') && summary?.owner === currentWorkspace

  let dataset: Dataset | undefined
  let error: string | undefined
  try {
    dataset = datasetSchema.parse(await controlPlane.getDataset(ctx, id, version ?? 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!dataset) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }

  // This version's tags (free-form labels) — mutable meta for distinguishing versions, separate from content tags (classification). Unrelated to version immutability.
  const versionTags = summary?.versionTags?.[dataset.version] ?? []

  // Case composition summary — distribution of environment (env.kind)·grading (grader.id) (by frequency). The benchmark's character at a glance.
  const envSummary = [
    ...dataset.cases.reduce((m, c) => {
      const k = c.env?.kind
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
      return m
    }, new Map<string, number>()),
  ].sort((a, b) => b[1] - a[1])
  const graderSummary = [
    ...dataset.cases.reduce((m, c) => {
      for (const g of c.graders) m.set(g.id, (m.get(g.id) ?? 0) + 1)
      return m
    }, new Map<string, number>()),
  ].sort((a, b) => b[1] - a[1])

  // Activity timeline — "who did what when" (created · scorecard run · comment) in chronological order. actor is display-prepared here.
  // Display name — profile name first, else email local part (don't expose the full email), else abbreviated subject.
  const resolveActor = (subject?: string): Actor => {
    if (!subject) return { name: t('systemActor'), known: false }
    const m = members.find((x) => x.subject === subject)
    return {
      name: m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(subject),
      ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      known: Boolean(m),
    }
  }
  const activity: ActivityItem[] = []
  if (summary?.createdAt)
    activity.push({
      kind: 'created',
      at: summary.createdAt,
      actor: resolveActor(summary.createdBy),
    })
  for (const sc of scorecards.filter((s) => s.dataset.id === id)) {
    const m = sc.summary?.find((x) => x.passRate != null) ?? sc.summary?.[0]
    activity.push({
      kind: 'scorecard',
      at: sc.createdAt,
      actor: resolveActor(sc.createdBy),
      scorecardId: sc.id,
      harnessId: sc.harness.id,
      harness: `${sc.harness.id}@${sc.harness.version}`,
      status: sc.status,
      passRate: m?.passRate ?? null,
    })
  }
  activity.sort((a, b) => a.at.localeCompare(b.at))

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={dataset.id}
          description={dataset.description ?? t('defaultDescription')}
          actions={
            <div className="flex items-center gap-2">
              {versions.length > 1 ? (
                <VersionSwitcher
                  id={dataset.id}
                  versions={versions}
                  current={dataset.version}
                  latest={versions[0]}
                  versionTags={summary?.versionTags ?? {}}
                />
              ) : (
                <Badge tone="neutral">v{dataset.version} (latest)</Badge>
              )}
              {versions.length > 1 && (
                <Link
                  href={`/${workspace}/datasets/${encodeURIComponent(dataset.id)}/diff`}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <GitCompare className="size-3.5" />
                  {t('compareVersions')}
                </Link>
              )}
              {canPublish && (
                <Link
                  href={`/${workspace}/datasets/${encodeURIComponent(dataset.id)}/new-version?v=${encodeURIComponent(dataset.version)}`}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <GitBranchPlus className="size-3.5" />
                  {t('newVersion')}
                </Link>
              )}
            </div>
          }
        />
      </div>

      {/* Meta panel — a readable meta strip + tag chips instead of a definition grid. Versions are immutable, so edits deploy via 'create new version'. */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Boxes className="size-3.5 text-faint" />
            {t('metaCases')}{' '}
            <span className="font-[560] tabular-nums text-foreground">{dataset.cases.length}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <History className="size-3.5 text-faint" />
            {t('metaVersions')}{' '}
            <span className="font-[560] tabular-nums text-foreground">{versions.length || 1}</span>
            {t('metaVersionsSuffix')}
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
              v{dataset.version}
              {versions.length === 0 || dataset.version === versions[0] ? ' · latest' : ''}
            </code>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <BarChart3 className="size-3.5 text-faint" />
            {t('metaScorecards')}{' '}
            <span className="font-[560] tabular-nums text-foreground">
              {relation?.scorecards ?? 0}
            </span>
          </span>
          {summary?.createdAt && (
            <span
              className="inline-flex items-center gap-1.5"
              title={`${t('metaCreatedPrefix')} ${fmtDateTimeFull(summary.createdAt)}${summary.updatedAt ? ` · ${t('metaUpdatedPrefix')} ${fmtDateTimeFull(summary.updatedAt)}` : ''}`}
            >
              <Clock className="size-3.5 text-faint" />
              {t('metaCreatedPrefix')} {fmtDateTime(summary.createdAt)}
              {summary.updatedAt && summary.updatedAt !== summary.createdAt
                ? ` · ${t('metaUpdatedPrefix')} ${fmtDateTime(summary.updatedAt)}`
                : ''}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1.5"
            title={t('metaAuthorTitle', { name: author.name })}
          >
            {author.known ? (
              <Avatar
                name={author.name}
                url={author.avatarUrl}
                size="sm"
                className="rounded-full"
              />
            ) : (
              <span className="text-faint">{t('metaAuthorLabel')}</span>
            )}
            {author.name}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
          <Tags className="size-3.5 text-faint" />
          {dataset.tags.length > 0 ? (
            dataset.tags.map((t) => (
              <span
                key={t}
                className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-inset ring-border"
              >
                {t}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-faint">{t('noTags')}</span>
          )}
          {/* Don't render guidance text inline — only via the info icon hover tooltip. */}
          {canPublish && (
            <InfoTip className="ml-auto" align="end" content={t('versionImmutableTip')} />
          )}
        </div>

        {/* This version's tags — free-form labels for distinguishing versions, separate from the content tags (classification) above. Hide the row if not editable + no tags. */}
        {(canPublish || versionTags.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('versionTagsLabel')}
            </span>
            <VersionTagsEditor
              entity="dataset"
              id={dataset.id}
              version={dataset.version}
              tags={versionTags}
              canEdit={canPublish}
            />
          </div>
        )}
      </Card>

      {/* Lineage/provenance — where this data came from. Original source (HF link) · official provenance · production path. */}
      {dataset.producedBy && (
        <DatasetLineage workspace={workspace} provenance={dataset.producedBy} />
      )}

      {/* Related harnesses — harnesses evaluated with this dataset (derived from scorecards). A summary of the activity timeline below. */}
      {relation && relation.harnesses.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 text-faint">
            <Waypoints className="size-3.5" />
            {t('evaluatedHarnesses')}
          </span>
          {relation.harnesses.map((h) => (
            <Link
              key={h}
              href={`/${workspace}/harnesses/${encodeURIComponent(h)}`}
              className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border transition-colors hover:text-foreground"
            >
              {h}
            </Link>
          ))}
        </div>
      )}

      {/* Activity (events) — created · scorecard runs in chronological order. Discussion (comments/replies) is in the CommentsSection below. */}
      <section className="space-y-3">
        <SectionHeader title={t('activityTitle')} />
        <ActivityTimeline workspace={workspace} items={activity} />
      </section>

      {/* Discussion — comments + replies (threads) + @mentions. A shared component across all detail views. */}
      <CommentsSection
        workspace={workspace}
        resourceType="dataset"
        resourceId={dataset.id}
        title={t('discussTitle')}
      />

      <section className="space-y-3">
        <SectionHeader title={t('casesTitle', { count: dataset.cases.length })} />
        {dataset.cases.length === 0 ? (
          <EmptyState title={t('noCases')} />
        ) : (
          <>
            {/* Composition summary — in what environment and with what this benchmark is graded, at a glance */}
            <div className="space-y-2 rounded-lg border bg-card/60 p-3.5">
              <div className="flex gap-3">
                <span className="w-9 shrink-0 pt-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
                  {t('caseEnvLabel')}
                </span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  {envSummary.length === 0 ? (
                    <span className="text-[12px] text-faint">—</span>
                  ) : (
                    envSummary.map(([kind, n]) => (
                      <span key={kind} className="inline-flex items-center gap-1">
                        <EnvBadge kind={kind} />
                        <span className="text-[12px] tabular-nums text-faint">{n}</span>
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="flex gap-3">
                <span className="w-9 shrink-0 pt-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
                  {t('caseGraderLabel')}
                </span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  {graderSummary.length === 0 ? (
                    <span className="text-[12px] text-faint">—</span>
                  ) : (
                    graderSummary.map(([gid, n]) => (
                      <span key={gid} className="inline-flex items-center gap-1">
                        <GraderBadge id={gid} />
                        <span className="text-[12px] tabular-nums text-faint">{n}</span>
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Per-case cards — 5 by default, expandable (the detail's focus is the activity history, so cases are secondary). */}
            <CaseList cases={dataset.cases} />
          </>
        )}
      </section>
    </div>
  )
}

// External link chip — lineage's official provenance links (homepage/paper/code/data/leaderboard).
function LinkChip({
  href,
  icon: Icon,
  label,
}: {
  href: string
  icon: typeof BookText
  label: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-[510] text-secondary-foreground ring-1 ring-inset ring-border transition-colors hover:text-foreground"
    >
      <Icon className="size-3" />
      {label}
      <ExternalLink className="size-2.5 text-faint" />
    </a>
  )
}

// Lineage/provenance card — "where this data came from". Original source (HF link) · official provenance · production path.
// For datasets, lineage is central (preserving the provenance of official open benchmarks) — label-value rows instead of a definition grid, for readability.
function DatasetLineage({
  workspace,
  provenance,
}: {
  workspace: string
  provenance: DatasetProvenance
}) {
  const t = useTranslations('datasetsPage')
  const { source, origin } = provenance
  const hfFileUrl =
    source?.kind === 'huggingface' && source.url && source.file
      ? `${source.url}/blob/main/${source.file}`
      : undefined

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
        <Waypoints className="size-3.5" /> {t('lineageTitle')}
      </div>

      {/* Original source — where the data rows came from (HF dataset/file link or pasted). */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
        <span className="w-14 shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('lineageSource')}
        </span>
        {source?.kind === 'huggingface' && source.dataset ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Database className="size-3.5 text-[#7cc0ff]" />
            <span className="text-muted-foreground">HuggingFace</span>
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono font-[510] text-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {source.dataset}
                <ExternalLink className="size-3 text-faint" />
              </a>
            ) : (
              <code className="font-mono text-foreground">{source.dataset}</code>
            )}
            {source.file ? (
              hfFileUrl ? (
                <a
                  href={hfFileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border transition-colors hover:text-foreground"
                >
                  <FileText className="size-3" />
                  {source.file}
                </a>
              ) : (
                <span className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
                  {source.file}
                </span>
              )
            ) : null}
            {source.config || source.split ? (
              <span className="font-mono text-[11px] text-faint">
                {[source.config, source.split].filter(Boolean).join(' / ')}
              </span>
            ) : null}
          </span>
        ) : source?.kind === 'jsonl' ? (
          <span className="text-muted-foreground">{t('lineagePastedJsonl')}</span>
        ) : (
          <span className="text-faint">{t('lineageUnknown')}</span>
        )}
      </div>

      {/* Official provenance — a published benchmark's homepage/paper/code/leaderboard + license/authors (if any). */}
      {origin &&
        (origin.homepage ||
          origin.paper ||
          origin.code ||
          origin.data ||
          origin.leaderboard ||
          origin.license ||
          origin.authors) && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 border-t pt-3 text-[12.5px]">
            <span className="w-14 shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('lineageOfficial')}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {origin.homepage && (
                <LinkChip href={origin.homepage} icon={ExternalLink} label={t('linkHomepage')} />
              )}
              {origin.paper && (
                <LinkChip href={origin.paper} icon={BookText} label={t('linkPaper')} />
              )}
              {origin.code && (
                <LinkChip href={origin.code} icon={ScrollText} label={t('linkCode')} />
              )}
              {origin.data && <LinkChip href={origin.data} icon={Database} label={t('linkData')} />}
              {origin.leaderboard && (
                <LinkChip href={origin.leaderboard} icon={Trophy} label={t('linkLeaderboard')} />
              )}
              {origin.license && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Scale className="size-3 text-faint" />
                  {origin.license}
                </span>
              )}
              {origin.authors && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Users className="size-3 text-faint" />
                  {origin.authors}
                </span>
              )}
            </span>
          </div>
        )}

      {/* Production path — recipe (backlink)/catalog/inline definition. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t pt-3 text-[12.5px]">
        <span className="w-14 shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('lineagePath')}
        </span>
        {provenance.via === 'recipe' ? (
          <Link
            href={`/${workspace}/recipes/${encodeURIComponent(provenance.id)}`}
            className="inline-flex items-center gap-1 font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ScrollText className="size-3.5" />
            {provenance.id}
            {provenance.version ? <span className="text-faint">@{provenance.version}</span> : null}
            <span className="text-faint">{t('lineageRecipe')}</span>
          </Link>
        ) : (
          <span className="font-mono text-muted-foreground">
            {provenance.via === 'catalog' ? t('lineageCatalog') : t('lineageInline')}
            {provenance.id ? <span className="text-faint"> · {provenance.id}</span> : null}
          </span>
        )}
      </div>
    </Card>
  )
}
