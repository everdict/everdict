'use client'

import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  CircleSlash,
  Github,
  History,
  Link2,
  Megaphone,
  Pencil,
  Plus,
  RotateCcw,
  Unlink,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import {
  initiativeStatusIcon,
  initiativeStatusSchema,
  initiativeStatusTone,
} from '@/entities/initiative'
import {
  ISSUE_LINK_REF_KIND,
  issueLinkHref,
  issueLinkTypeSchema,
  issueStatusIcon,
  issueStatusSchema,
  issueStatusTone,
  type TrackerHistoryEntry,
} from '@/entities/issue'
import { memberNameOf, type MemberDirectory } from '@/entities/member'
import { projectStatusIcon, projectStatusSchema, projectStatusTone } from '@/entities/project'
import { cn } from '@/shared/lib/utils'
import {
  ActivityActorName,
  ActivityFeed,
  ActivityRow,
  type ActivityActor,
  type ActivityTone,
} from '@/shared/ui/activity-feed'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'
import { Link } from '@/shared/ui/link'

import { detailFlag, detailNumber, detailString, detailStrings } from '../lib/history-detail'
import { TrackerStatusMove, type TrackerKind } from './tracker-status'

// How many to show at first — the rest arrive through "show earlier history". The domain holds up to 200 entries
// (TRACKER_HISTORY_LIMIT), so an issue with frequent GitHub syncing would bury the screen in history if expanded whole.
const INITIAL = 10
const STEP = 20

// The names of the changed fields an `updated` carries — only what is in the catalog is translated, and an unknown key is shown
// verbatim (so history does not break when the control plane adds a field).
const KNOWN_FIELDS = [
  'title',
  'description',
  'labels',
  'assignee',
  'project',
  'name',
  'targetDate',
  'initiative',
  'state',
  'github',
] as const

// What CAUSED a status transition — stated as a chip only when it was not a person who moved it (regression watching, GitHub sync).
const NAMED_CAUSES = ['github_sync', 'regression'] as const

function isNamedCause(cause: string | undefined): cause is (typeof NAMED_CAUSES)[number] {
  return NAMED_CAUSES.some((c) => c === cause)
}

// The tracker history — read as one line of "icon · who · what · value", like Linear's activity feed. Storage order (oldest first) is
// left alone and only the most recent are shown, so further UP is further into the past.
export function TrackerHistory({
  kind,
  subject,
  entries,
  actors,
  workspace,
}: {
  kind: TrackerKind
  // The kind noun that goes in the sentence ("issue") — it comes from the calling screen's catalog.
  subject: string
  entries: readonly TrackerHistoryEntry[]
  actors: MemberDirectory
  workspace: string
}) {
  const t = useTranslations('tracker')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [shown, setShown] = useState(INITIAL)

  const start = Math.max(0, entries.length - shown)
  const visible = entries.slice(start)
  const hidden = start

  return (
    <div className="space-y-3">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShown((s) => s + STEP)}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[12px] font-[510] text-muted-foreground shadow-raise transition-colors hover:border-border-strong hover:text-foreground"
        >
          <History className="size-3.5" />
          {t('history.showPrevious', { count: hidden })}
        </button>
      )}
      <ActivityFeed>
        {visible.map((entry, i) => (
          <HistoryRow
            key={`${entry.at}-${start + i}`}
            entry={entry}
            kind={kind}
            subject={subject}
            actors={actors}
            workspace={workspace}
            locale={locale}
            timeZone={timeZone}
          />
        ))}
      </ActivityFeed>
    </div>
  )
}

function HistoryRow({
  entry,
  kind,
  subject,
  actors,
  workspace,
  locale,
  timeZone,
}: {
  entry: TrackerHistoryEntry
  kind: TrackerKind
  subject: string
  actors: MemberDirectory
  workspace: string
  locale: string
  timeZone?: string
}) {
  const t = useTranslations('tracker')
  const detail = entry.detail
  const profile = actors[entry.by]
  const name = memberNameOf(actors, entry.by)
  // A workspace member's face becomes the node; anyone else (a system subject) gets the event icon as the node.
  const actor: ActivityActor | undefined = profile
    ? {
        name: profile.name,
        ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
      }
    : undefined

  const fieldLabel = (key: string): string =>
    KNOWN_FIELDS.some((f) => f === key) ? t(`historyField.${key}`) : key

  const cause = detailString(detail, 'cause')
  const causeChip = isNamedCause(cause) ? (
    <Badge tone="outline">{t(`historyCause.${cause}`)}</Badge>
  ) : null

  const scorecardId = detailString(detail, 'scorecardId')
  const scorecardChip = scorecardId ? (
    <Link
      href={`/${workspace}/scorecard/${encodeURIComponent(scorecardId)}`}
      className="transition-colors hover:text-foreground"
    >
      <Badge tone="neutral">
        <EntityRef id={scorecardId} />
      </Badge>
    </Link>
  ) : null

  const shape = describe()

  return (
    <ActivityRow
      actor={actor}
      icon={shape.icon}
      tone={shape.tone}
      at={entry.at}
      locale={locale}
      timeZone={timeZone}
    >
      <ActivityActorName name={name} />
      <span>{shape.text}</span>
      {shape.values}
    </ActivityRow>
  )

  // One event rendered as "icon · sentence · value chips". The sentence is always kept short (what was done) and every changed value
  // is pulled out as a chip — a value embedded in the sentence drags it into Korean/English word order and particles.
  function describe(): { icon: LucideIcon; tone: ActivityTone; text: string; values: ReactNode } {
    switch (entry.event) {
      case 'created':
        return {
          icon: Plus,
          tone: 'neutral',
          text: t('history.created', { subject }),
          values: null,
        }
      case 'updated': {
        const fields = detailStrings(detail, 'changed').map(fieldLabel)
        const detached = detailString(detail, 'detached')
        return {
          icon: Pencil,
          tone: 'neutral',
          text:
            fields.length > 0
              ? t('history.updated', { fields: fields.join(', ') })
              : t('history.updatedUnknown'),
          // An unlinked entry still carries its provenance — what was severed is the SYNC, not where it came from.
          values: detached ? <RepoChip detail={detail} fallback={detached} /> : null,
        }
      }
      case 'status_changed': {
        const to = detailString(detail, 'to')
        return {
          icon: statusIcon(kind, to) ?? ArrowRightLeft,
          tone: statusTone(kind, to),
          text: t('history.statusChanged'),
          values: (
            <>
              <TrackerStatusMove kind={kind} from={detailString(detail, 'from')} to={to} />
              {causeChip}
            </>
          ),
        }
      }
      case 'resolved':
        return {
          icon: CheckCircle2,
          tone: 'success',
          text: t('history.resolved', { subject }),
          values: (
            <>
              {scorecardChip}
              {causeChip}
            </>
          ),
        }
      case 'reopened': {
        const to = detailString(detail, 'to')
        const regressed = to === 'regressed'
        return {
          icon: regressed ? AlertTriangle : RotateCcw,
          tone: regressed ? 'danger' : 'warning',
          text: t('history.reopened', { subject }),
          values: (
            <>
              <TrackerStatusMove kind={kind} from={detailString(detail, 'from')} to={to} />
              {causeChip}
              {scorecardChip}
            </>
          ),
        }
      }
      case 'completed': {
        // A completion closed while open issues remain must read as "forced", not as "met the deadline".
        const forced = detailFlag(detail, 'forced')
        const openIssues = detailNumber(detail, 'openIssues')
        const late = detail?.['onTime'] === false
        return {
          icon: CheckCircle2,
          tone: forced ? 'warning' : 'success',
          text: t('history.completed', { subject }),
          values: (
            <>
              {forced && <Badge tone="danger">{t('history.forced')}</Badge>}
              {forced && openIssues !== undefined && openIssues > 0 && (
                <Badge tone="outline">{t('history.openIssues', { count: openIssues })}</Badge>
              )}
              {late && <Badge tone="warning">{t('history.late')}</Badge>}
            </>
          ),
        }
      }
      // A release shipped (records/product.ts) — a forced ship must read as "shipped knowingly", not as "shipped clean", so it leaves
      // forced/openIssues/regressed series as chips in the same grammar a project completion uses.
      case 'released': {
        const forced = detailFlag(detail, 'forced')
        const openIssues = detailNumber(detail, 'openIssues')
        const regressed = detailStrings(detail, 'regressedSeries')
        const late = detail?.['onTime'] === false
        return {
          icon: CheckCircle2,
          tone: forced ? 'warning' : 'success',
          text: t('history.released', { subject }),
          values: (
            <>
              {forced && <Badge tone="danger">{t('history.forced')}</Badge>}
              {forced && openIssues !== undefined && openIssues > 0 && (
                <Badge tone="outline">{t('history.openIssues', { count: openIssues })}</Badge>
              )}
              {regressed.map((key) => (
                <Badge key={key} tone="danger">
                  {key}
                </Badge>
              ))}
              {late && <Badge tone="warning">{t('history.late')}</Badge>}
            </>
          ),
        }
      }
      case 'cancelled':
        return {
          icon: CircleSlash,
          tone: 'neutral',
          text: t('history.cancelled', { subject }),
          values: null,
        }
      case 'linked':
      case 'unlinked': {
        const added = entry.event === 'linked'
        return {
          icon: added ? Link2 : Unlink,
          tone: 'neutral',
          text: t(added ? 'history.linked' : 'history.unlinked'),
          values: <LinkTarget workspace={workspace} detail={detail} linked={added} />,
        }
      }
      case 'github_imported': {
        return {
          icon: Github,
          tone: 'neutral',
          text: t('history.githubImported', { subject }),
          values: <RepoChip detail={detail} />,
        }
      }
      case 'github_pulled': {
        const changed = detailStrings(detail, 'changed').map(fieldLabel)
        const remoteState = detailString(detail, 'remoteState')
        return {
          icon: Github,
          tone: 'neutral',
          text:
            changed.length > 0
              ? t('history.githubPulledFields', { fields: changed.join(', ') })
              : t('history.githubPulled'),
          values: remoteState ? (
            <Badge tone="outline">
              {t(`historyGithubState.${remoteState === 'closed' ? 'closed' : 'open'}`)}
            </Badge>
          ) : null,
        }
      }
      case 'github_pushed': {
        const state = detailString(detail, 'state')
        return {
          icon: Github,
          tone: 'neutral',
          text: t('history.githubPushed'),
          values: state ? (
            <Badge tone="outline">
              {t(`historyGithubState.${state === 'closed' ? 'closed' : 'open'}`)}
            </Badge>
          ) : null,
        }
      }
      case 'github_push_failed': {
        const message = detailString(detail, 'message')
        return {
          icon: Github,
          tone: 'danger',
          text: t('history.githubPushFailed'),
          values: message ? (
            <span className="min-w-0 truncate text-[12px] text-destructive" title={message}>
              {message}
            </span>
          ) : null,
        }
      }
      case 'update_posted': {
        // What state a project or initiative SAID it was in — the verdict is the badge, and the sentence belongs to the update timeline.
        const health = detailString(detail, 'health')
        return {
          icon: Megaphone,
          tone: health === 'off_track' ? 'danger' : health === 'at_risk' ? 'warning' : 'success',
          text: t('history.updatePosted'),
          values: health ? <Badge tone="outline">{t(`health.${health}`)}</Badge> : null,
        }
      }
      case 'moved': {
        // A team move is the only event where the NAME changes — which name it went from and to is the whole of this row.
        const from = detailString(detail, 'fromIdentifier')
        const to = detailString(detail, 'toIdentifier')
        return {
          icon: ArrowRightLeft,
          tone: 'neutral',
          text: t('history.moved'),
          values: (
            <>
              {from && <Badge tone="outline">{from}</Badge>}
              {to && <Badge tone="neutral">{to}</Badge>}
            </>
          ),
        }
      }
      case 'member_added':
      case 'member_removed': {
        const added = entry.event === 'member_added'
        const member = detailString(detail, 'subject')
        return {
          icon: added ? UserPlus : UserMinus,
          tone: 'neutral',
          text: t(added ? 'history.memberAdded' : 'history.memberRemoved'),
          values: member ? <Badge tone="neutral">{memberNameOf(actors, member)}</Badge> : null,
        }
      }
      default:
        // The control plane started writing a new event before this web did — better to leave it verbatim than to drop the row.
        return { icon: History, tone: 'neutral', text: entry.event, values: null }
    }
  }
}

function statusIcon(kind: TrackerKind, value: string | undefined): LucideIcon | undefined {
  if (value === undefined) return undefined
  if (kind === 'issue') {
    const parsed = issueStatusSchema.safeParse(value)
    return parsed.success ? issueStatusIcon(parsed.data) : undefined
  }
  if (kind === 'project') {
    const parsed = projectStatusSchema.safeParse(value)
    return parsed.success ? projectStatusIcon(parsed.data) : undefined
  }
  const parsed = initiativeStatusSchema.safeParse(value)
  return parsed.success ? initiativeStatusIcon(parsed.data) : undefined
}

function statusTone(kind: TrackerKind, value: string | undefined): ActivityTone {
  if (value === undefined) return 'neutral'
  const tone =
    kind === 'issue'
      ? toTone(issueStatusSchema.safeParse(value), issueStatusTone)
      : kind === 'project'
        ? toTone(projectStatusSchema.safeParse(value), projectStatusTone)
        : toTone(initiativeStatusSchema.safeParse(value), initiativeStatusTone)
  return tone
}

// Map a badge tone (outline included) onto a feed tone — outline is the colourless neutral.
function toTone<T>(
  parsed: { success: true; data: T } | { success: false },
  toneOf: (value: T) => 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'outline'
): ActivityTone {
  if (!parsed.success) return 'neutral'
  const tone = toneOf(parsed.data)
  return tone === 'outline' ? 'neutral' : tone
}

// A link target — the asset kind (faint) plus id@version. You can walk straight into the target screen from it.
function LinkTarget({
  workspace,
  detail,
  linked,
}: {
  workspace: string
  detail: Record<string, unknown> | undefined
  linked: boolean
}) {
  const t = useTranslations('tracker')
  const parsed = issueLinkTypeSchema.safeParse(detailString(detail, 'type'))
  const id = detailString(detail, 'id')
  if (!parsed.success || id === undefined) return null
  const type = parsed.data
  const version = detailString(detail, 'version')
  const dataset = detailString(detail, 'dataset')
  const chip = (
    <Badge tone="neutral" className={cn(!linked && 'line-through decoration-faint')}>
      <span className="text-faint">{t(`linkType.${type}`)}</span>
      <EntityRef
        id={id}
        {...(version !== undefined ? { version } : {})}
        {...(ISSUE_LINK_REF_KIND[type] !== undefined ? { kind: ISSUE_LINK_REF_KIND[type] } : {})}
      />
    </Badge>
  )
  // A severed link is no longer somewhere to go — only the chip is kept, with no address attached.
  if (!linked) return chip
  return (
    <Link
      href={issueLinkHref(workspace, type, id, dataset)}
      className="transition-colors hover:text-foreground"
    >
      {chip}
    </Link>
  )
}

// The GitHub original — owner/repo#12. The domain leaves the address (url) on the history detail self-sufficiently, so "where was this
// imported from" opens directly from here even after the live connection is severed. An older entry with no url stays as text only
// (no address is invented by assuming github.com — on a GHE copy that sends you somewhere wrong).
function RepoChip({
  detail,
  fallback,
}: {
  detail: Record<string, unknown> | undefined
  // The string an older entry with no structured provenance carries (`owner/repo#42`) — shown as text when present.
  fallback?: string
}) {
  const repository = detailString(detail, 'repository')
  const number = detailNumber(detail, 'number')
  const url = detailString(detail, 'url')
  if (repository === undefined && fallback === undefined) return null
  const chip = (
    <Badge tone="outline">
      <Github className="size-3" />
      <span className="font-mono">
        {repository ?? fallback}
        {repository !== undefined && number !== undefined && `#${number}`}
      </span>
    </Badge>
  )
  if (url === undefined) return chip
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="transition-colors hover:text-foreground"
    >
      {chip}
    </a>
  )
}
