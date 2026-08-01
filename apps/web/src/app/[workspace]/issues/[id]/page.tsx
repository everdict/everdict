import Link from 'next/link'
import { ChevronLeft, Clock, FolderKanban, Github, Link2, User } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { IssueGithubPanel } from '@/features/import-github-issues'
import { IssueEvaluationHistory, type IssueEvaluationEntry } from '@/features/issue-evaluation'
import { IssueLinks } from '@/features/issue-links'
import { IssueActions, IssueStatusControl } from '@/features/manage-issue'
import { issueSchema, issueScorecardsSchema, type Issue } from '@/entities/issue'
import { membersSchema } from '@/entities/member'
import { projectsSchema, type Project } from '@/entities/project'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EntityRef } from '@/shared/ui/chip'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/issues`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// One issue — the unit of intent, with the evidence that verifies it gathered in one place: what it links,
// how it was evaluated, what closed it, and (when it regressed) the baseline it fell from.
export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('issuesPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let issue: Issue | undefined
  let error: string | undefined
  try {
    issue = issueSchema.parse(await controlPlane.getIssue(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!issue) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }
  const current = issue

  // Supplementary reads — the detail still renders if any of them fails.
  const evaluation = await controlPlane
    .listIssueScorecards(ctx, id)
    .then((r) => issueScorecardsSchema.parse(r))
    .catch(() => ({ scorecards: [], linked: [] }))
  const projects: Project[] = await controlPlane
    .listProjects(ctx)
    .then((r) => projectsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  const project = current.projectId ? projects.find((p) => p.id === current.projectId) : undefined
  const displayName = (subject: string): string => {
    const m = members.find((x) => x.subject === subject)
    return m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(subject)
  }

  const linked = new Set(evaluation.linked)
  const entries: IssueEvaluationEntry[] = evaluation.scorecards.map((s) => {
    const metric = s.summary?.find((m) => m.passRate != null) ?? s.summary?.[0]
    return {
      id: s.id,
      dataset: s.dataset,
      harness: s.harness,
      passRate: metric?.passRate ?? null,
      status: s.status,
      createdAt: s.createdAt,
      pinned: linked.has(s.id),
      baseline: current.resolution?.scorecardId === s.id,
    }
  })

  // The resolve dialog offers the scorecards this issue already has in view — the evidence is picked from
  // what actually ran against it, not typed from memory.
  const resolvable = evaluation.scorecards.map((s) => ({
    id: s.id,
    label: `${s.dataset.id} · ${s.harness.id} · ${fmtDateTime(s.createdAt, timeZone)}`,
  }))

  const history = [...current.history].reverse()

  return (
    <div className="@container space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={current.title}
          actions={
            <div className="flex items-center gap-2">
              <IssueStatusControl
                id={current.id}
                status={current.status}
                canWrite={canWrite}
                scorecards={resolvable}
              />
              {canWrite && (
                <IssueActions
                  workspace={workspace}
                  issue={current}
                  projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                />
              )}
            </div>
          }
        />
      </div>

      {/* Meta strip — the readable "who/where/when" line, not a definition grid. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          {current.assignee && (
            <span className="inline-flex items-center gap-1.5">
              <User className="size-3.5 text-faint" />
              {displayName(current.assignee)}
            </span>
          )}
          {project && (
            <Link
              href={`/${workspace}/projects/${encodeURIComponent(project.id)}`}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <FolderKanban className="size-3.5 text-faint" />
              {project.name}
            </Link>
          )}
          {current.labels.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {current.labels.map((label) => (
                <Badge key={label} tone="outline">
                  {label}
                </Badge>
              ))}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1.5"
            title={`${t('metaCreated')} ${fmtDateTimeFull(current.createdAt, { timeZone })}`}
          >
            <Clock className="size-3.5 text-faint" />
            {t('metaCreated')} {fmtDateTime(current.createdAt, timeZone)}
            {current.updatedAt !== current.createdAt
              ? ` · ${t('metaUpdated')} ${fmtDateTime(current.updatedAt, timeZone)}`
              : ''}
          </span>
          {current.github && (
            <a
              href={current.github.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <Github className="size-3.5 text-faint" />
              {current.github.repository}#{current.github.number}
            </a>
          )}
        </div>
      </Card>

      {current.description && (
        <section className="space-y-3">
          <SectionHeader title={t('descriptionTitle')} />
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
            {current.description}
          </p>
        </section>
      )}

      {/* Only an imported issue has a remote half — an issue filed here shows nothing (hide-empty rule). */}
      {current.github && (
        <section className="space-y-3">
          <SectionHeader title={t('githubTitle')} />
          <IssueGithubPanel issueId={current.id} github={current.github} canWrite={canWrite} />
        </section>
      )}

      {(current.links.length > 0 || canWrite) && (
        <section className="space-y-3">
          <SectionHeader title={t('linksTitle')} />
          <IssueLinks
            workspace={workspace}
            issueId={current.id}
            links={current.links}
            canWrite={canWrite}
          />
        </section>
      )}

      {entries.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title={t('evaluationTitle')}
            action={
              <span className="text-[12px] tabular-nums text-faint">
                {t('evaluationCount', { count: entries.length })}
              </span>
            }
          />
          <IssueEvaluationHistory workspace={workspace} entries={entries} timeZone={timeZone} />
        </section>
      )}

      {/* The resolution is KEPT across a reopen on purpose — a regressed issue must still show the scorecard
          it fell from, because that is the baseline the regression was measured against. */}
      {current.resolution && (
        <section className="space-y-3">
          <SectionHeader title={t('resolutionTitle')} />
          <Card className="space-y-2.5 p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-muted-foreground">
              <span>
                {t('resolutionBy', {
                  name: displayName(current.resolution.by),
                  at: fmtDateTime(current.resolution.at, timeZone),
                })}
              </span>
              {current.status === 'regressed' && (
                <Badge tone="danger">{t('resolutionRegressed')}</Badge>
              )}
            </div>
            {current.resolution.scorecardId && (
              <Link
                href={`/${workspace}/scorecards/${encodeURIComponent(current.resolution.scorecardId)}`}
                className="inline-flex items-center gap-1.5 text-[12.5px] transition-colors hover:text-foreground"
              >
                <Link2 className="size-3.5 text-faint" />
                <EntityRef id={current.resolution.scorecardId} />
              </Link>
            )}
            {current.resolution.note && (
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                {current.resolution.note}
              </p>
            )}
          </Card>
        </section>
      )}

      {history.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('historyTitle')} />
          <ol className="space-y-1.5 border-l border-border pl-4">
            {/* 점 중심을 세로선 한가운데에 올린다: pl-4(16px) + 선 두께 절반(0.5px) + 점 반지름(3px) */}
            {history.map((entry, i) => (
              <li
                key={`${entry.at}-${i}`}
                className="relative text-[12.5px] text-muted-foreground before:absolute before:-left-[19.5px] before:top-1.5 before:size-1.5 before:rounded-full before:bg-border"
              >
                <span className="text-foreground">{tracker(`historyEvent.${entry.event}`)}</span>
                {' · '}
                {displayName(entry.by)}
                {' · '}
                <time title={fmtDateTimeFull(entry.at, { timeZone })}>
                  {fmtDateTime(entry.at, timeZone)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="issue"
        resourceId={current.id}
        title={t('discussTitle')}
      />
    </div>
  )
}
