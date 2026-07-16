import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft, FileText, GitBranchPlus, GitCompare, Lock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { DeleteHarnessButton } from '@/features/delete-harness'
import { CommentsSection } from '@/features/discuss'
import { HarnessVersionSwitcher } from '@/features/harness-versions'
import { HarnessDetail, RawConfigDisclosure } from '@/features/inspect-harness'
import { CiLinkPanel } from '@/features/manage-ci-links'
import { HarnessSinkSelect, HarnessSourceSelect } from '@/features/manage-trace-source'
import { VersionTagsEditor } from '@/features/version-tags'
import { ciLinksResponseSchema, type CiLink } from '@/entities/ci-link'
import { datasetsSchema } from '@/entities/dataset'
import {
  harnessesSchema,
  harnessInstanceSpecSchema,
  harnessSpecSchema,
  harnessTemplateSpecSchema,
  harnessVersionsSchema,
  type Harness,
  type HarnessInstanceSpec,
  type HarnessKind,
  type HarnessSpec,
  type HarnessTemplateSpec,
} from '@/entities/harness'
import { membersSchema } from '@/entities/member'
import { traceSourcesResponseSchema, type TraceSourcesResponse } from '@/entities/trace-source'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

const KIND_TONE: Record<HarnessKind, 'info' | 'warning' | 'neutral'> = {
  service: 'info',
  command: 'warning',
  process: 'neutral',
}

// Meta item — a label(left)·value(right) row, same as the config value list (DefRow). Repeated inside a divided Card.
function MetaItem({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}) {
  return (
    <div
      className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4"
      {...(title ? { title } : {})}
    >
      <span className="shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint sm:w-20">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
        {children}
      </div>
    </div>
  )
}

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/harnesses`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

export default async function HarnessDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { workspace, id } = await params
  const { v } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')

  let versions: string[] = []
  let versionTags: Record<string, string[]> = {}
  let spec: HarnessSpec | undefined
  let error: string | undefined
  let active: string | undefined
  try {
    const detail = harnessVersionsSchema.parse(await controlPlane.getHarness(ctx, id))
    versions = detail.versions
    versionTags = detail.versionTags ?? {}
    const requested = typeof v === 'string' && versions.includes(v) ? v : undefined
    active = requested ?? versions[versions.length - 1] // latest = semver/registration-order topmost
    if (active) spec = harnessSpecSchema.parse(await controlPlane.getHarnessSpec(ctx, id, active))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // List meta (classification·registrant·time) + creator name (members join) — supplementary info, so the detail view still renders even if it fails.
  const entry: Harness | undefined = await controlPlane
    .listHarnesses(ctx)
    .then((r) => harnessesSchema.parse(r).find((h) => h.id === id))
    .catch(() => undefined)
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const currentWorkspace = principal?.workspace ?? workspace
  // Creator — profile name+avatar (if any). Seed/_shared (different owner·no createdBy) are shown as first-party.
  const author = (() => {
    if (!entry?.createdBy) {
      return {
        name: entry && entry.owner !== currentWorkspace ? 'first-party' : '—',
        known: false as const,
      }
    }
    const m = members.find((x) => x.subject === entry.createdBy)
    return {
      name: m?.name ?? m?.email ?? fmtSubject(entry.createdBy),
      ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      known: true as const,
    }
  })()

  // Original config (template reference + pins) + this version's changelog (description). The starting point for editing a new version.
  // Separate from resolve, so the detail keeps rendering even if it fails. description lives only on the instance (independent of template fetch success), so it's pulled out separately.
  let config: { instance: HarnessInstanceSpec; template: HarnessTemplateSpec } | undefined
  let versionNote: string | undefined
  if (active && spec) {
    const instance = await controlPlane
      .getHarnessInstance(ctx, id, active)
      .then((r) => harnessInstanceSpecSchema.parse(r))
      .catch(() => undefined)
    const note = instance?.description?.trim()
    versionNote = note ? note : undefined
    if (instance) {
      const template = await controlPlane
        .getHarnessTemplateSpec(ctx, instance.template.id, instance.template.version)
        .then((r) => harnessTemplateSpecSchema.parse(r))
        .catch(() => undefined)
      if (template) config = { instance, template }
    }
  }

  // Whether version tags are editable — same gate as registration (harnesses:register) + only when owned by this workspace
  // (_shared/first-party are rejected by the control plane with 404, so the edit UI itself is hidden).
  const canTagVersions =
    can(principal?.roles, 'harnesses:register') &&
    entry !== undefined &&
    entry.owner === currentWorkspace

  // Delete (versions / whole harness) — admin only (the creator exception is server-side) + workspace-owned
  // (_shared/first-party delete 404s at the control plane, so the affordance is hidden for them).
  const canDeleteHarness =
    can(principal?.roles, 'harnesses:delete') &&
    entry !== undefined &&
    entry.owner === currentWorkspace

  // Trace sources (the ONE registered pool) + this harness's two use-site selections — which source to PULL its trace
  // from (grading input) and which to EXPORT judged results to. The detail renders even if it fails (only the rows hide).
  const traceSources: TraceSourcesResponse = await controlPlane
    .listTraceSources(ctx)
    .then((r) => traceSourcesResponseSchema.parse(r))
    .catch(() => ({ sources: [], assignments: {}, sinkAssignments: {} }))
  const assignedSource: string | undefined = traceSources.assignments[id]
  const assignedSink: string | undefined = traceSources.sinkAssignments[id]
  // Export targets are sink-capable sources only (otel is pull-only — it can't be an export target).
  const exportTargets = traceSources.sources.filter((s) => s.kind !== 'otel')

  // CI integration (repo link) — links matched to this harness + my GitHub connection needed for the repo picker + dataset candidates.
  // The detail keeps rendering even if all three fail (only the panel is empty). Save/unlink is admin (settings:write) — the control plane is the final enforcer.
  let ciLinks: CiLink[] = []
  let ciDatasets: string[] = []
  if (spec) {
    try {
      ciLinks = ciLinksResponseSchema
        .parse(await controlPlane.listCiLinks(ctx))
        .links.filter((l) => l.harness === id)
    } catch {
      ciLinks = []
    }
    try {
      ciDatasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx)).map((d) => d.id)
    } catch {
      ciDatasets = []
    }
  }

  if (!spec) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={id} />
        <Callout tone="danger">{t('loadError', { error: error ?? t('unknownError') })}</Callout>
      </div>
    )
  }

  // One-line summary per kind — the header description.
  const summary =
    spec.kind === 'service'
      ? t('summaryService', {
          svc: spec.services?.length ?? 0,
          dep: spec.dependencies?.length ?? 0,
          target: spec.target ? t('summaryTargetSuffix') : '',
        })
      : spec.kind === 'command'
        ? t('summaryCommand', {
            tool: spec.command?.split(' ')[0] ?? 'cli',
            setup: spec.setup?.length ?? 0,
          })
        : t('summaryProcess')

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={spec.id}
          description={summary}
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2">
              {versions.length > 1 ? (
                <HarnessVersionSwitcher
                  id={id}
                  versions={versions}
                  current={active ?? ''}
                  latest={versions[versions.length - 1]}
                  versionTags={versionTags}
                />
              ) : (
                <Badge tone="neutral">v{active} · latest</Badge>
              )}
              {versions.length > 1 && (
                <Link
                  href={`/${workspace}/harnesses/${encodeURIComponent(id)}/diff`}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <GitCompare className="size-3.5" />
                  {t('compareVersions')}
                </Link>
              )}
              <Link
                href={`/${workspace}/harnesses/${encodeURIComponent(id)}/new-version?v=${encodeURIComponent(active ?? '')}`}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                <GitBranchPlus className="size-3.5" />
                {t('newVersion')}
              </Link>
              {canDeleteHarness && (
                <DeleteHarnessButton
                  id={id}
                  versions={versions}
                  latest={versions[versions.length - 1] ?? active ?? ''}
                  workspace={workspace}
                  versionTags={versionTags}
                />
              )}
            </div>
          }
        />
      </div>

      {/* This version's changelog (description) — a free-form note entered at deploy time. Hide the section itself if absent (don't render empty sections). */}
      {versionNote && (
        <Card className="p-5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
            <FileText className="size-3.5" />
            {t('versionChangeNote')}
          </div>
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">
            {versionNote}
          </p>
        </Card>
      )}

      {/* Meta — label(left)·value(right) items in a responsive grid. The wider the screen, the more columns (2→3→4) to spread out generously. */}
      <Card className="grid grid-cols-1 gap-x-10 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <MetaItem label={t('metaKind')}>
          <Badge tone={KIND_TONE[spec.kind]}>{spec.kind}</Badge>
        </MetaItem>
        {entry?.category && <MetaItem label={t('metaCategory')}>{entry.category}</MetaItem>}
        <MetaItem label={t('metaVersion')}>
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11.5px] text-secondary-foreground">
            v{active}
          </code>
          {active === versions[versions.length - 1] && (
            <span className="text-[11px] text-faint">latest</span>
          )}
          <span className="text-[11px] text-faint">
            {t('versionCountMeta', { count: versions.length || 1 })}
          </span>
        </MetaItem>
        {/* This version's tags (free-form labels) — hide the row itself if not editable + no tags (don't render empty sections).
            _shared (first-party) harnesses can't be tagged (registry 404s) → show editing only when owned by the workspace. */}
        {active && (canTagVersions || (versionTags[active] ?? []).length > 0) && (
          <MetaItem label={t('metaTags')}>
            <VersionTagsEditor
              entity="harness"
              id={id}
              version={active}
              tags={versionTags[active] ?? []}
              canEdit={canTagVersions}
            />
          </MetaItem>
        )}
        {entry?.createdAt && (
          <MetaItem
            label={t('metaCreated')}
            title={t('createdTitle', { time: fmtDateTimeFull(entry.createdAt) })}
          >
            {fmtDateTime(entry.createdAt)}
          </MetaItem>
        )}
        {entry?.updatedAt && entry.updatedAt !== entry.createdAt && (
          <MetaItem
            label={t('metaUpdated')}
            title={t('updatedTitle', { time: fmtDateTimeFull(entry.updatedAt) })}
          >
            {fmtDateTime(entry.updatedAt)}
          </MetaItem>
        )}
        <MetaItem label={t('metaAuthor')}>
          {author.known && <Avatar name={author.name} url={author.avatarUrl} size="sm" />}
          <span>{author.name}</span>
        </MetaItem>
        {/* Per-harness PULL source — hide the row if there are no sources and no selection (don't render empty sections). */}
        {(traceSources.sources.length > 0 || assignedSource !== undefined) && (
          <MetaItem label={t('metaTraceSource')}>
            <HarnessSourceSelect
              harnessId={id}
              sources={traceSources.sources.map((s) => ({ name: s.name, kind: s.kind }))}
              {...(assignedSource !== undefined ? { current: assignedSource } : {})}
              canAssign={can(principal?.roles, 'harnesses:register')}
            />
          </MetaItem>
        )}
        {/* Per-harness EXPORT target (a sink-capable trace source) — hide the row if there are no eligible sources and no selection. */}
        {(exportTargets.length > 0 || assignedSink !== undefined) && (
          <MetaItem label={t('metaTraceSink')}>
            <HarnessSinkSelect
              harnessId={id}
              sinks={exportTargets.map((s) => ({ name: s.name, kind: s.kind }))}
              {...(assignedSink !== undefined ? { current: assignedSink } : {})}
              canAssign={can(principal?.roles, 'harnesses:register')}
            />
          </MetaItem>
        )}
        {entry?.private && (
          <MetaItem label={t('metaVisibility')}>
            <span className="inline-flex items-center gap-1 text-[var(--color-warning)]">
              <Lock className="size-3" /> {t('visibilityPrivate')}
            </span>
          </MetaItem>
        )}
      </Card>

      {/* Config — the final settings this harness actually runs with, in a clean value view. The raw (pins/overrides)·JSON is collapsible. */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-[560] tracking-[-0.01em] text-foreground">
            {t('configHeading')}
          </h2>
          <p className="text-[12px] text-muted-foreground">{t('configDescription')}</p>
        </div>
        <HarnessDetail spec={spec} />
        <RawConfigDisclosure {...(config ? { config } : {})} spec={spec} />
      </section>

      <CiLinkPanel
        harnessId={spec.id}
        kind={spec.kind}
        serviceNames={spec.kind === 'service' ? (spec.services ?? []).map((s) => s.name) : []}
        datasets={ciDatasets}
        initialLinks={ciLinks}
        canWrite={can(principal?.roles, 'settings:write')}
        workspace={workspace}
      />

      <CommentsSection
        workspace={workspace}
        resourceType="harness"
        resourceId={spec.id}
        title={t('discussTitle')}
      />
    </div>
  )
}
