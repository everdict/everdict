import { notFound } from 'next/navigation'
import { GitCommit, GitPullRequest } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  changeCampaignHref,
  changeCampaignSchema,
  type ChangeCampaign,
} from '@/entities/change-campaign'
import { issueHref } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// One `change` campaign in full. READ-ONLY on purpose: every field is produced by the session that did the
// work — the commits it made, the gate runs it ran with their numbers, its answer to each criterion — and a
// form here would be a person asserting someone else's observation. What the page adds is the thing a person
// needs and an agent does not: the walk back to the request, and the chain this attempt continues.

const STATE_TONE: Record<
  string,
  'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'outline'
> = {
  open: 'info',
  adopted: 'success',
  partially_adopted: 'warning',
  abandoned: 'danger',
}
const ANSWER_TONE: Record<string, string> = {
  met: 'text-emerald-600 dark:text-emerald-400',
  not_met: 'text-destructive',
  not_run: 'text-amber-600 dark:text-amber-400',
}

export default async function ChangeCampaignPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const ctx = await authContext()
  const t = await getTranslations('changeCampaignPage')
  // The two shared vocabularies — a campaign's state and a judgement's answer — have ONE owner, so the
  // section on the issue page and this page cannot drift into two names for `partially_adopted`.
  const words = await getTranslations('lineage')

  let campaign: ChangeCampaign | undefined
  let error: string | undefined
  try {
    campaign = changeCampaignSchema.parse(await controlPlane.getChangeCampaign(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  if (!campaign) {
    // `controlPlaneError` keeps only the envelope's MESSAGE (shared/lib/control-plane.ts), so there is no
    // status here to switch on — the sentence is the only evidence. Matched narrowly on purpose: this route
    // also answers 404 `NOT_FOUND` when the deployment has no evolution store wired ("change campaign service
    // not configured"), and turning THAT into a 404 page would report a read we could not perform as a
    // campaign that does not exist. Absence gets the 404; everything else, including not-configured, stays a
    // visible unknown with its reason on the screen.
    if (error !== undefined && /not found/i.test(error)) notFound()
    return (
      <div className="space-y-5">
        <PageHeader title={t('title')} />
        <Callout tone="danger">{t('loadError', { error: error ?? t('unstated') })}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${campaign.service.repository}${campaign.service.path ? `/${campaign.service.path}` : ''}`}
        description={
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={STATE_TONE[campaign.state] ?? 'neutral'}>
              {words(`state.${campaign.state}`)}
            </Badge>
            {/* The walk back to the request — the reason this campaign exists at all. */}
            <Link href={issueHref(workspace, campaign.issueId)}>{t('theRequest')}</Link>
            {campaign.continues ? (
              <Link href={changeCampaignHref(workspace, campaign.continues)}>
                {t('continues', { id: campaign.continues.slice(0, 8) })}
              </Link>
            ) : null}
          </span>
        }
      />

      {/* THE COUNT, first — a request is satisfied in pieces, and "two of the five" is the sentence a person
          opens this page to read. It is derived by the control plane from the criteria and the latest round's
          answers, so this section can never disagree with the answers printed below it. */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('requirements')}</h2>
        <p className="text-sm">
          {t('requirementCount', {
            total: campaign.requirements.total,
            settled: campaign.requirements.settled,
            unsettled: campaign.requirements.unsettled.length,
          })}
        </p>
        {campaign.requirements.unsettled.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {campaign.requirements.unsettled.map((requirement) => (
              <li
                key={requirement.issueId}
                className="flex flex-wrap items-baseline gap-2"
              >
                {/* Each unmet requirement is its own issue, so "what is still owed" is a place to go rather
                    than a line to read. */}
                <Link href={issueHref(workspace, requirement.issueId)}>{requirement.issueId}</Link>
                {requirement.blockers.map((blocker) => (
                  <span key={blocker.criterionId} className="text-xs text-muted-foreground">
                    {t('blockedBy', {
                      criterion: blocker.criterionId,
                      reason: words(`unmetReason.${blocker.reason}`),
                    })}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        ) : null}
        {/* ⚠️ An incomplete count says so. Criteria written before the record held what they judge cannot be
            classified without guessing, and a guess here would report an unmet REQUEST as a passed gate. */}
        {campaign.requirements.unclassifiedCriteria > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('unclassifiedNote', { count: campaign.requirements.unclassifiedCriteria })}
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('criteria')}</h2>
        <ul className="space-y-1 text-sm">
          {campaign.criteria.map((criterion) => (
            <li key={criterion.id} className="flex flex-wrap items-baseline gap-2">
              <Badge tone={criterion.judges.kind === 'requirement' ? 'info' : 'outline'}>
                {words(`judges.${criterion.judges.kind}`)}
              </Badge>
              <span className="text-muted-foreground">{criterion.id}</span>
              <span>— {criterion.statement}</span>
              {criterion.judges.kind === 'requirement' ? (
                <Link href={issueHref(workspace, criterion.judges.issueId)}>
                  {criterion.judges.issueId}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t('rounds')}</h2>
        {campaign.rounds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noRounds')}</p>
        ) : null}
        {campaign.rounds.map((round) => {
          const runs = new Map(round.gateRuns.map((run) => [run.id, run]))
          return (
            <div key={round.seq} className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-muted-foreground">#{round.seq}</span>
                <Badge tone={round.outcome === 'adopted' ? 'success' : 'warning'}>
                  {words(`outcome.${round.outcome}`)}
                </Badge>
                <span>{round.hypothesis}</span>
                <span className="text-xs text-muted-foreground">
                  {t('judgedBy', { by: round.judgement.by })}
                </span>
              </div>

              <ul className="space-y-1">
                {round.judgement.answers.map((answer) => (
                  <li key={answer.criterionId} className="flex flex-wrap items-baseline gap-2">
                    <span className={ANSWER_TONE[answer.answer] ?? ''}>
                      {words(`answer.${answer.answer}`)}
                    </span>
                    <span className="text-muted-foreground">{answer.criterionId}</span>
                    <span className="text-xs text-muted-foreground">
                      {words(`how.${answer.how}`)}
                    </span>
                    {/* "Why not" is the half a reader acts on: only `attempted_and_failed` means "do the work
                        again", the rest name something to go and get. */}
                    {answer.answer !== 'met' ? (
                      <span className="text-xs text-muted-foreground">
                        {words(`unmetReason.${answer.reason}`)}
                      </span>
                    ) : null}
                    {/* An observation must point at a measurement — so the page shows the numbers, not the word. */}
                    {answer.gateRunIds.map((runId) => {
                      const run = runs.get(runId)
                      if (!run) return null
                      return (
                        <span key={runId} className="text-xs text-muted-foreground">
                          <code>{run.command}</code> {t('exitCode', { code: run.exitCode })} ·{' '}
                          {run.metrics
                            .map((m) => `${m.name} ${m.value}${m.unit ? ` ${m.unit}` : ''}`)
                            .join(' · ')}
                        </span>
                      )
                    })}
                  </li>
                ))}
              </ul>

              <ul className="space-y-1">
                {round.changes.map((change) => (
                  <li
                    key={`${change.repository}-${change.commits.map((c) => c.sha).join('-')}`}
                    className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  >
                    <GitCommit className="size-3" aria-hidden />
                    {change.repository}
                    {change.path ? `/${change.path}` : ''}
                    {change.commits.map((commit) => (
                      <span key={commit.sha}>
                        <code>{commit.sha.slice(0, 7)}</code>
                        {commit.message ? ` ${commit.message}` : ''}
                      </span>
                    ))}
                    {change.pr ? (
                      <span className="inline-flex items-center gap-1">
                        <GitPullRequest className="size-3" aria-hidden />#{change.pr.number}{' '}
                        {change.pr.mergedSha
                          ? t('merged', { sha: change.pr.mergedSha.slice(0, 7) })
                          : t('prOpen')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>

              {/* A rejected round's lesson is why it is kept rather than deleted. */}
              {round.learned ? (
                <p className="text-xs text-muted-foreground">
                  {t('learned', { text: round.learned })}
                </p>
              ) : null}
            </div>
          )
        })}
      </section>

      {campaign.close ? (
        <section className="space-y-1 text-sm">
          <h2 className="text-sm font-medium">{t('howItEnded')}</h2>
          <p>
            {words(`state.${campaign.close.state}`)} — {campaign.close.reason}
          </p>
          {campaign.close.landed.length > 0 || campaign.close.remaining.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('landedAndOwed', {
                landed: campaign.close.landed.map((s) => s.repository).join(', ') || t('none'),
                remaining:
                  campaign.close.remaining.map((s) => s.repository).join(', ') || t('none'),
              })}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {campaign.close.knowledge.length > 0
              ? t('knowledgeCount', { count: campaign.close.knowledge.length })
              : t('knowledgeDeclined', {
                  reason: campaign.close.knowledgeDeclined ?? t('unstated'),
                })}
          </p>
        </section>
      ) : null}
    </div>
  )
}
