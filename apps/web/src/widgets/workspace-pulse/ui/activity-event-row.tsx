import type { ReactNode } from 'react'
import { ArrowRight, BookOpen, Bot, CircleDot, FlaskConical, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { memberNameOf, type MemberDirectory } from '@/entities/member'
import type { PlatformEvent } from '@/entities/platform-event'
import { HealthBadge, trackerHealthSchema } from '@/entities/tracker-health'
import {
  detailNumber,
  detailString,
  TrackerStatusMove,
  type TrackerKind,
} from '@/entities/tracker-history'
import { fmtPct, fmtUsd } from '@/shared/lib/format'
import { ActivityActorName, ActivityRow, type ActivityTone } from '@/shared/ui/activity-feed'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'
import { Link } from '@/shared/ui/link'

// An event kind has the grammar `<subject>.<verb>` (a subject can be two words, as in agent.run.started, so it is split at the
// LAST dot). Subject and verb are translated separately and stood up as chips, rather than translating one sentence per kind:
//   ① maintaining two locales' sentences for more than sixty kinds falls quietly behind every time a kind is added,
//   ② in Korean, the moment a value is embedded in a sentence its particle changes with the value — so a value is always a chip
//      (the rule `shared/ui/activity-feed` already settled).
// An unknown token is left verbatim: better than an old reader hiding a fact a new deployment recorded.
function splitKind(kind: string): { subject: string; verb: string } {
  const at = kind.lastIndexOf('.')
  if (at < 0) return { subject: catalogKey(kind), verb: '' }
  return { subject: catalogKey(kind.slice(0, at)), verb: catalogKey(kind.slice(at + 1)) }
}

// The token usable as a catalog key. next-intl reads a dot in a key as a NESTED PATH, so looking up `agent.run` as-is searches
// `activitySubject → agent → run` and always fails (in production this one row rendered as the raw English "agent.run").
// A two-word subject is flattened with an underscore into a single-segment key.
function catalogKey(token: string): string {
  return token.replaceAll('.', '_')
}

// Which axis the fact belongs to — one icon separates "this is about work" from "this is about evaluation". The same split the
// server pins in the contract (@everdict/contracts `activityAxisOf`), but here it only picks an icon, so the prefix decides.
function iconOf(kind: string): LucideIcon {
  if (kind.startsWith('agent.') || kind.startsWith('approval.') || kind.startsWith('checkpoint.'))
    return Bot
  if (kind.startsWith('file.') || kind.startsWith('knowledge.')) return BookOpen
  if (
    kind.startsWith('run.') ||
    kind.startsWith('scorecard.') ||
    kind.startsWith('harness.') ||
    kind.startsWith('dataset.') ||
    kind.startsWith('judge.') ||
    kind.startsWith('report.') ||
    kind.startsWith('schedule.') ||
    kind.startsWith('trace.') ||
    kind.startsWith('runtime.') ||
    kind.startsWith('budget.')
  )
    return FlaskConical
  return CircleDot
}

// Colour is used only for the NATURE of the fact — broken, finished, everything else. It does not judge (the same reason the contract records only facts).
function toneOf(kind: string): ActivityTone {
  if (kind.endsWith('.failed') || kind.endsWith('.exceeded') || kind.endsWith('.circuit_opened'))
    return 'danger'
  if (kind.endsWith('.threshold_crossed') || kind.endsWith('.placement_blocked')) return 'warning'
  if (kind.endsWith('.completed') || kind.endsWith('.approved')) return 'success'
  return 'neutral'
}

// Subject type → the address that one thing lives at. A type not here is not linked: a link with nowhere to go is worse than none,
// and those screens do not open from an id alone.
const DETAIL_ROUTE: Record<string, string> = {
  issue: 'issue',
  project: 'project',
  initiative: 'initiative',
  scorecard: 'scorecard',
  run: 'run',
  dataset: 'dataset',
  harness: 'harness',
  judge: 'judge',
  runtime: 'runtime',
  schedule: 'schedule',
  view: 'view',
  skill: 'skill',
}

function hrefOf(workspace: string, event: PlatformEvent): string | undefined {
  const segment = DETAIL_ROUTE[event.subject.type]
  return segment === undefined
    ? undefined
    : `/${workspace}/${segment}/${encodeURIComponent(event.subject.id)}`
}

// The HANDLE a person calls the thing by (identifier, name, path) — short, quotable values only. A payload is an unvalidated bag
// (the same rule as the tracker history's `history-detail`), so a non-string value counts as absent.
// With no handle nothing is drawn — this used to draw `subject.id`, which is a 36-character uuid, so every row carried an
// unreadable string.
const CITE_KEYS = ['identifier', 'name', 'key', 'path', 'agentId'] as const

// Values that are SENTENCES rather than handles — an issue title, an update/comment excerpt, a task title, a batch refusal reason.
// Handles are mono and sentences are body type: mixed into one slot, neither is readable.
const QUOTE_KEYS = ['title', 'excerpt', 'subject', 'reason'] as const

function firstString(
  payload: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

// The subjects whose `.status_changed` from→to can be drawn as the same status badges the lists use.
function trackerKindOf(subjectType: string): TrackerKind | undefined {
  return subjectType === 'issue' || subjectType === 'project' || subjectType === 'initiative'
    ? subjectType
    : undefined
}

// An `id@version` string (the harness/dataset spelling in a run/scorecard payload) or a bare id → an EntityRef chip.
function RefChip({
  value,
  kind,
}: {
  value: string | undefined
  kind?: 'harness' | 'dataset' | 'judge'
}) {
  if (value === undefined) return null
  const at = value.lastIndexOf('@')
  const id = at > 0 ? value.slice(0, at) : value
  const version = at > 0 ? value.slice(at + 1) : undefined
  return (
    <Badge tone="outline">
      <EntityRef
        id={id}
        {...(version !== undefined ? { version } : {})}
        {...(kind !== undefined ? { kind } : {})}
      />
    </Badge>
  )
}

// A short machine handle (a case id, a tool name, a path) — the same mono treatment as the quote slot.
function MonoChip({ value }: { value: string | undefined }) {
  if (value === undefined) return null
  return (
    <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{value}</span>
  )
}

// from → to drawn as two free badges (a move outside the status vocabulary — an issue's team-move identifier, say).
function MoveChips({ from, to }: { from: string | undefined; to: string | undefined }) {
  if (from === undefined && to === undefined) return null
  return (
    <span className="inline-flex items-center gap-1">
      {from !== undefined && <Badge tone="outline">{from}</Badge>}
      {from !== undefined && to !== undefined && (
        <ArrowRight className="size-3 shrink-0 text-faint" aria-hidden />
      )}
      {to !== undefined && <Badge tone="neutral">{to}</Badge>}
    </span>
  )
}

const DECISION_TONE = { approved: 'success', denied: 'danger', expired: 'outline' } as const

// One row of the home activity feed — "who · what · what happened" read out of the payload's materials. The sentence is still a
// composition of the subject and verb vocabularies (see splitKind above), but the CONTENT of the fact stands as value chips: a
// status is a from→to badge, a batch is its pass rate, a file is its path, an approval is its decision. Only an event with no
// materials at all falls back to the server-built English line (`message`) — the raw sentence beats a row showing nothing.
export function ActivityEventRow({
  event,
  more = 0,
  workspace,
  directory,
  locale,
  timeZone,
}: {
  event: PlatformEvent
  // How many consecutive same-kind events by the same actor this row stands in for (excluding itself). The home feed passes it when
  // it folds a burst — half of the mechanism that stops an agent publishing a dozen files in one turn from eating the whole feed.
  more?: number
  workspace: string
  directory: MemberDirectory
  locale: string
  timeZone?: string
}) {
  const t = useTranslations('overviewPage')
  const tTracker = useTranslations('tracker')
  const payload = event.payload
  const { subject, verb } = splitKind(event.kind)
  const profile = event.actor === undefined ? undefined : directory[event.actor]
  const href = hrefOf(workspace, event)
  const cited = firstString(payload, CITE_KEYS)
  const noun = t.has(`activitySubject.${subject}`) ? t(`activitySubject.${subject}`) : subject
  const values = chips()
  // Only a row with neither a quote nor a chip falls back to `message` — laying the raw sentence over a row that has them says the same thing twice.
  const quote =
    firstString(payload, QUOTE_KEYS) ??
    (values === null && cited === undefined ? event.message : undefined)

  return (
    <ActivityRow
      {...(profile ? { actor: profile } : {})}
      icon={iconOf(event.kind)}
      tone={toneOf(event.kind)}
      at={event.createdAt}
      locale={locale}
      timeZone={timeZone}
    >
      {event.actor !== undefined && profile !== undefined && (
        <ActivityActorName name={memberNameOf(directory, event.actor)} />
      )}
      {/* The fact's raw one-line form (English data the server built) goes in `title` — the sentence on screen is always translated
          vocabulary, and the raw form is needed only when you want to confirm exactly what was recorded. */}
      {href === undefined ? (
        <span className="font-[560] text-foreground" title={event.message}>
          {noun}
        </span>
      ) : (
        <Link
          href={href}
          title={event.message}
          className="font-[560] text-foreground hover:underline"
        >
          {noun}
        </Link>
      )}
      <Badge tone="outline">
        {t.has(`activityVerb.${verb}`) ? t(`activityVerb.${verb}`) : verb}
      </Badge>
      {more > 0 && <Badge tone="neutral">{t('activityMore', { count: more })}</Badge>}
      {values}
      {cited !== undefined && <MonoChip value={cited} />}
      {quote !== undefined && (
        <span className="min-w-0 truncate text-[12px] text-muted-foreground" title={quote}>
          {quote}
        </span>
      )}
    </ActivityRow>
  )

  // Per-kind value chips — the materials the payload carries, in a shape a person reads. The same principle as the tracker history's
  // describe(): keep the sentence short and put every changed value in a chip. A malformed payload silently loses just that chip.
  function chips(): ReactNode | null {
    const kind = event.kind

    // A status transition — the three tracker kinds use the same status badges as their lists, every other subject uses free badges for from→to.
    if (kind.endsWith('.status_changed')) {
      const trackerKind = trackerKindOf(event.subject.type)
      const from = detailString(payload, 'from')
      const to = detailString(payload, 'to')
      if (from === undefined && to === undefined) return null
      const cause = detailString(payload, 'cause')
      return (
        <>
          {trackerKind !== undefined ? (
            <TrackerStatusMove kind={trackerKind} from={from} to={to} />
          ) : (
            <MoveChips from={from} to={to} />
          )}
          {(cause === 'github_sync' || cause === 'regression') && (
            <Badge tone="outline">{tTracker(`historyCause.${cause}`)}</Badge>
          )}
        </>
      )
    }
    // A team move is an event where the IDENTIFIER changes — which name it went from and to is the whole of this row.
    if (kind === 'issue.moved') {
      return (
        <MoveChips
          from={detailString(payload, 'fromIdentifier')}
          to={detailString(payload, 'toIdentifier')}
        />
      )
    }
    if (kind.endsWith('.update_posted')) {
      const health = trackerHealthSchema.safeParse(payload['health'])
      return health.success ? <HealthBadge health={health.data} /> : null
    }
    if (kind === 'issue.linked') {
      const linkType = detailString(payload, 'linkType')
      const linkId = detailString(payload, 'linkId')
      if (linkId === undefined) return null
      return (
        <Badge tone="neutral">
          {linkType !== undefined && tTracker.has(`linkType.${linkType}`) && (
            <span className="text-faint">{tTracker(`linkType.${linkType}`)}</span>
          )}
          <EntityRef id={linkId} {...versionProp()} />
        </Badge>
      )
    }
    if (kind === 'run.submitted' || kind === 'run.completed' || kind === 'run.failed') {
      return (
        <>
          <RefChip value={detailString(payload, 'harness')} kind="harness" />
          <MonoChip value={detailString(payload, 'caseId')} />
        </>
      )
    }
    if (kind.startsWith('scorecard.') && kind !== 'scorecard.moved') {
      const passRate = detailNumber(payload, 'passRate')
      const verdict = payload['verdict']
      return (
        <>
          <RefChip value={detailString(payload, 'harness')} kind="harness" />
          <RefChip value={detailString(payload, 'dataset')} kind="dataset" />
          <MonoChip value={detailString(payload, 'caseId')} />
          {verdict === true && <Badge tone="success">{t('activityVerdict.pass')}</Badge>}
          {verdict === false && <Badge tone="danger">{t('activityVerdict.fail')}</Badge>}
          {passRate !== undefined && (
            <Badge tone="outline" className="tabular-nums">
              {fmtPct(passRate)}
            </Badge>
          )}
        </>
      )
    }
    // A registered or transferred capability — its id(@version) with that kind's icon. A subject outside the kinds (scorecard.moved's
    // team uuid) is not drawn: an unreadable value is worse than none.
    if (kind.endsWith('.registered') || kind.endsWith('.moved')) {
      const capabilityKind =
        event.subject.type === 'harness' ||
        event.subject.type === 'dataset' ||
        event.subject.type === 'judge'
          ? event.subject.type
          : undefined
      if (capabilityKind === undefined) return null
      const id = detailString(payload, 'id')
      if (id === undefined) return null
      const version = detailString(payload, 'version')
      return (
        <RefChip value={version !== undefined ? `${id}@${version}` : id} kind={capabilityKind} />
      )
    }
    if (kind === 'approval.requested' || kind === 'approval.decided') {
      const decision = detailString(payload, 'decision')
      const known =
        decision === 'approved' || decision === 'denied' || decision === 'expired'
          ? decision
          : undefined
      return (
        <>
          {known !== undefined && (
            <Badge tone={DECISION_TONE[known]}>{t(`activityDecision.${known}`)}</Badge>
          )}
          <MonoChip value={detailString(payload, 'tool')} />
        </>
      )
    }
    if (kind === 'team.member_added' || kind === 'team.member_removed') {
      const member = detailString(payload, 'member')
      return member === undefined ? null : (
        <Badge tone="neutral">{memberNameOf(directory, member)}</Badge>
      )
    }
    if (kind === 'cycle.created' || kind === 'cycle.completed') {
      const number = detailNumber(payload, 'number')
      const carriedOver = detailNumber(payload, 'carriedOver')
      return (
        <>
          {number !== undefined && <Badge tone="outline">#{number}</Badge>}
          {carriedOver !== undefined && carriedOver > 0 && (
            <Badge tone="warning">{t('activityCarriedOver', { count: carriedOver })}</Badge>
          )}
        </>
      )
    }
    if (kind === 'trace.threshold_crossed') {
      const metric = detailString(payload, 'metric')
      const value = detailNumber(payload, 'value')
      const limit = detailNumber(payload, 'limit')
      return (
        <>
          <MonoChip value={detailString(payload, 'threshold')} />
          {metric !== undefined && value !== undefined && limit !== undefined && (
            <MonoChip value={`${metric} ${value}/${limit}`} />
          )}
        </>
      )
    }
    if (kind === 'budget.exceeded') {
      const spent = detailNumber(payload, 'spentUsd')
      const cap = detailNumber(payload, 'capUsd')
      if (spent === undefined || cap === undefined) return null
      return <MonoChip value={`${fmtUsd(spent)} / ${fmtUsd(cap)}`} />
    }
    if (kind === 'runtime.circuit_opened')
      return <MonoChip value={detailString(payload, 'runtime')} />
    return null
  }

  function versionProp(): { version: string } | Record<string, never> {
    const version = detailString(payload, 'version')
    return version !== undefined ? { version } : {}
  }
}
