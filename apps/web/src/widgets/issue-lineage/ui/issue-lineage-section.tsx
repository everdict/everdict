import { GitCommit } from 'lucide-react'

import type { IssueLineage } from '@/entities/issue'

// What a request caused, as one section: the campaigns opened against it, each round's commits per service,
// and the knowledge reachable from the issue or from one of its campaigns.
//
// Read-only and server-rendered — it has no controls, so it is a section rather than an island.

const OUTCOME_TONE: Record<string, string> = {
  adopted: 'text-emerald-600 dark:text-emerald-400',
  rejected: 'text-amber-600 dark:text-amber-400',
  judged: 'text-sky-600 dark:text-sky-400',
  not_comparable: 'text-muted-foreground',
}

const STATE_LABEL: Record<string, string> = {
  open: 'open',
  adopted: 'adopted',
  partially_adopted: 'partially adopted',
  abandoned: 'abandoned',
}

export function IssueLineageSection({ lineage }: { lineage: IssueLineage }) {
  const unavailable = Object.entries(lineage.sources)
    .filter(([, state]) => state === 'unavailable')
    .map(([name]) => name)
  const hasAnything = lineage.campaigns.length > 0 || lineage.knowledge.length > 0

  if (!hasAnything && unavailable.length === 0) return null

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Lineage</h2>

      {lineage.campaigns.map((campaign) => (
        <div key={campaign.id} className="rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{campaign.grade}</span>
            <span className="text-muted-foreground">
              {STATE_LABEL[campaign.state] ?? campaign.state}
            </span>
            {campaign.service ? (
              <span className="text-muted-foreground">
                · {campaign.service.repository}
                {campaign.service.path ? `/${campaign.service.path}` : ''}
              </span>
            ) : null}
            {campaign.continues ? (
              <span className="text-xs text-muted-foreground">
                · continues {campaign.continues.slice(0, 8)}
              </span>
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
                  <span className={OUTCOME_TONE[round.outcome] ?? ''}>{round.outcome}</span>
                  {round.answers ? (
                    <span className="text-xs text-muted-foreground">
                      {round.answers.met} met · {round.answers.notMet} not met ·{' '}
                      {round.answers.notRun} not run
                      {' · '}
                      {round.answers.observed} observed / {round.answers.asserted} asserted
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
              <li className="text-xs text-muted-foreground">no rounds</li>
            ) : null}
          </ol>
        </div>
      ))}

      {lineage.knowledge.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {lineage.knowledge.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.kind}</span>
              <span
                className={entry.status === 'active' ? '' : 'text-muted-foreground line-through'}
              >
                {entry.title}
              </span>
              {/* Both edges, because an entry pinned to the issue AND a campaign is reachable twice. */}
              <span className="text-xs text-muted-foreground">
                {entry.reachedBy.issue ? 'via request' : null}
                {entry.reachedBy.issue && entry.reachedBy.campaigns.length > 0 ? ' · ' : null}
                {entry.reachedBy.campaigns.length > 0
                  ? `via ${entry.reachedBy.campaigns.map((id) => id.slice(0, 8)).join(', ')}`
                  : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {unavailable.length > 0 ? (
        // Absent is a different claim from empty, and the page has to make it: a source this deployment does
        // not wire must not render as a request that caused nothing.
        <p className="text-xs text-muted-foreground">
          Not read here: {unavailable.join(', ')} — this deployment does not have them wired, so
          their part of the lineage is unknown rather than empty.
        </p>
      ) : null}
    </section>
  )
}
