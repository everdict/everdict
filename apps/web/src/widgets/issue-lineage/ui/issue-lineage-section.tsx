import { GitCommit } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { changeCampaignHref } from '@/entities/change-campaign'
import type { IssueLineage } from '@/entities/issue'
import { Link } from '@/shared/ui/link'

// What a request caused, as one section: the campaigns opened against it, each round's commits per service,
// and the knowledge reachable from the issue or from one of its campaigns.
//
// Read-only and server-rendered — it has no controls, so it is a section rather than an island.

// How far a walked ancestor is inset. A STATIC map because a class name built at runtime
// (`ml-${n * 3}`) is never seen by the compiler and ships as no margin at all.
const DEPTH_INSET: Record<number, string> = {
  1: '',
  2: 'ml-3 border-l pl-3',
  3: 'ml-6 border-l pl-3',
  4: 'ml-9 border-l pl-3',
  5: 'ml-12 border-l pl-3',
}
const inset = (depth: number | undefined) => DEPTH_INSET[depth ?? 1] ?? DEPTH_INSET[5]

const OUTCOME_TONE: Record<string, string> = {
  adopted: 'text-emerald-600 dark:text-emerald-400',
  rejected: 'text-amber-600 dark:text-amber-400',
  judged: 'text-sky-600 dark:text-sky-400',
  not_comparable: 'text-muted-foreground',
}

export async function IssueLineageSection({
  lineage,
  workspace,
}: {
  lineage: IssueLineage
  workspace: string
}) {
  const t = await getTranslations('lineage')
  // `state` and `outcome` are free strings on the wire — the union of two grades' enums, which nothing in the
  // types says. The catalog covers both (shared/i18n/lineage-vocabulary.test.ts pins that), and this is the
  // case that test cannot reach: an API deployed AHEAD of this web, sending a word the catalog has never
  // heard. Showing the raw value is ugly and true; showing `lineage.state.whatever` is a broken screen only a
  // browser console would report.
  const word = (key: string, raw: string) => (t.has(key) ? t(key) : raw)
  // One campaign's page, chosen by grade — the evaluated grade is driven from the web, the change grade is
  // written by an agent and read here. Used by the campaign's own link AND by its chain link.
  const campaignHref = (grade: string, id: string) =>
    grade === 'change' ? changeCampaignHref(workspace, id) : `/${workspace}/campaign/${id}`
  const unavailable = Object.entries(lineage.sources)
    .filter(([, state]) => state === 'unavailable')
    .map(([name]) => name)
  const hasAnything = lineage.campaigns.length > 0 || lineage.knowledge.length > 0

  if (!hasAnything && unavailable.length === 0) return null

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{t('title')}</h2>

      {lineage.campaigns.map((campaign) => (
        <div key={campaign.id} className={`rounded-md border p-3 text-sm ${inset(campaign.depth)}`}>
          <div className="flex items-center gap-2">
            <Link
              href={campaignHref(campaign.grade, campaign.id)}
              className="rounded bg-muted px-1.5 py-0.5 text-xs"
            >
              {word(`grade.${campaign.grade}`, campaign.grade)}
            </Link>
            <span className="text-muted-foreground">
              {word(`state.${campaign.state}`, campaign.state)}
            </span>
            {/* An ancestor says so on its own card — the chain is a chain here, not a link to elsewhere. */}
            {campaign.depth !== undefined && campaign.depth > 1 ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t('hopsBack', { n: campaign.depth - 1 })}
              </span>
            ) : null}
            {campaign.service ? (
              <span className="text-muted-foreground">
                · {campaign.service.repository}
                {campaign.service.path ? `/${campaign.service.path}` : ''}
              </span>
            ) : null}
            {campaign.continues ? (
              <Link
                href={campaignHref(campaign.grade, campaign.continues)}
                className="text-xs text-muted-foreground"
              >
                {t('continues', { id: campaign.continues.slice(0, 8) })}
              </Link>
            ) : null}
          </div>

          <ol className="mt-2 space-y-1">
            {campaign.rounds.map((round) => {
              const changes = lineage.changes.filter(
                (change) => change.campaignId === campaign.id && change.roundSeq === round.seq
              )
              return (
                <li key={round.seq} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">#{round.seq}</span>
                  {/* A rejected round stays on the page: what failed is what the next attempt was built on. */}
                  <span className={OUTCOME_TONE[round.outcome] ?? ''}>
                    {word(`outcome.${round.outcome}`, round.outcome)}
                  </span>
                  {round.answers ? (
                    <span className="text-xs text-muted-foreground">
                      {t('answers', {
                        met: round.answers.met,
                        notMet: round.answers.notMet,
                        notRun: round.answers.notRun,
                        observed: round.answers.observed,
                        asserted: round.answers.asserted,
                      })}
                    </span>
                  ) : null}
                  {changes.map((change) => (
                    <span
                      key={`${change.repository}-${change.commits.map((c) => c.sha).join('-')}`}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    >
                      <GitCommit className="size-3" aria-hidden />
                      {change.repository}
                      {change.path ? `/${change.path}` : ''}@
                      {change.commits.map((commit) => commit.sha.slice(0, 7)).join(', ')}
                    </span>
                  ))}
                </li>
              )
            })}
            {campaign.rounds.length === 0 ? (
              <li className="text-xs text-muted-foreground">{t('noRounds')}</li>
            ) : null}
          </ol>
        </div>
      ))}

      {lineage.knowledge.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {lineage.knowledge.map((entry) => (
            <li
              key={entry.id}
              className={`flex flex-wrap items-baseline gap-2 ${inset(entry.depth)}`}
            >
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.kind}</span>
              <span
                className={entry.status === 'active' ? '' : 'text-muted-foreground line-through'}
              >
                {entry.title}
              </span>
              {/* Both edges, because an entry pinned to the issue AND a campaign is reachable twice. */}
              <span className="text-xs text-muted-foreground">
                {entry.reachedBy.issue ? t('viaRequest') : null}
                {entry.reachedBy.issue && entry.reachedBy.campaigns.length > 0 ? ' · ' : null}
                {entry.reachedBy.campaigns.length > 0
                  ? t('viaCampaigns', {
                      ids: entry.reachedBy.campaigns.map((id) => id.slice(0, 8)).join(', '),
                    })
                  : null}
                {/* The way in that only the walk produces: nobody pinned this entry to the request — the
                    request's own entry replaced it, which is what makes it history rather than noise. */}
                {entry.reachedBy.supersededBy
                  ? t('viaSuperseded', { id: entry.reachedBy.supersededBy.slice(0, 8) })
                  : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {lineage.walk && (lineage.walk.truncated || lineage.walk.cycles > 0 || lineage.walk.unresolved > 0) ? (
        // A bounded walk that does not say it was bounded reports "there is no more" when it means "I
        // stopped". Each line below is a different thing for the reader to do about it.
        <div className="space-y-0.5 text-xs text-muted-foreground">
          {lineage.walk.truncated ? <p>{t('walkTruncated', { depth: lineage.walk.requested })}</p> : null}
          {lineage.walk.cycles > 0 ? <p>{t('walkCycles', { count: lineage.walk.cycles })}</p> : null}
          {lineage.walk.unresolved > 0 ? (
            <p>{t('walkUnresolved', { count: lineage.walk.unresolved })}</p>
          ) : null}
        </div>
      ) : null}

      {unavailable.length > 0 ? (
        // Absent is a different claim from empty, and the page has to make it: a source this deployment does
        // not wire must not render as a request that caused nothing.
        <p className="text-xs text-muted-foreground">
          {t('unavailable', { sources: unavailable.join(', ') })}
        </p>
      ) : null}
    </section>
  )
}
