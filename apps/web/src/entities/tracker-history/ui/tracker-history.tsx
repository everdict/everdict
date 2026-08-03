'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
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
  InitiativeStatusBadge,
  initiativeStatusIcon,
  initiativeStatusSchema,
  initiativeStatusTone,
} from '@/entities/initiative'
import {
  ISSUE_LINK_REF_KIND,
  issueLinkHref,
  issueLinkTypeSchema,
  IssueStatusBadge,
  issueStatusIcon,
  issueStatusSchema,
  issueStatusTone,
  type TrackerHistoryEntry,
} from '@/entities/issue'
import { memberNameOf, type MemberDirectory } from '@/entities/member'
import {
  ProjectStatusBadge,
  projectStatusIcon,
  projectStatusSchema,
  projectStatusTone,
} from '@/entities/project'
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

import { detailFlag, detailNumber, detailString, detailStrings } from '../lib/history-detail'

// 처음 보여줄 개수 — 나머지는 "이전 이력 더 보기"로. 도메인이 이력을 200개까지 들고 있어서
// (TRACKER_HISTORY_LIMIT) GitHub 동기화가 잦은 이슈는 그대로 펼치면 화면이 이력으로 덮인다.
const INITIAL = 10
const STEP = 20

// 이력을 가진 트래커 레코드. 상태 어휘가 종류마다 달라(이슈 7 · 프로젝트 4 · 이니셔티브 3) 상태 칩을
// 고를 때만 쓰인다.
export type TrackerKind = 'issue' | 'cycle' | 'project' | 'initiative'

// `updated` 가 싣는 변경 필드 이름 — 카탈로그에 있는 것만 번역하고 모르는 키는 원문 그대로 보여준다
// (제어 평면이 새 필드를 추가해도 이력이 깨지지 않는다).
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

// 상태 전이를 일으킨 원인 — 사람이 옮긴 게 아닐 때만(회귀 감시·GitHub 동기화) 칩으로 밝힌다.
const NAMED_CAUSES = ['github_sync', 'regression'] as const

function isNamedCause(cause: string | undefined): cause is (typeof NAMED_CAUSES)[number] {
  return NAMED_CAUSES.some((c) => c === cause)
}

// 트래커 이력 — Linear 의 활동 피드처럼 "아이콘 · 누가 · 무엇을 · 값" 한 줄로 읽힌다. 저장 순서(오래된 것
// 먼저)를 그대로 두고 최근 것만 보여주므로, 위로 갈수록 과거다.
export function TrackerHistory({
  kind,
  subject,
  entries,
  actors,
  workspace,
}: {
  kind: TrackerKind
  // 문장에 들어갈 종류 이름("이슈"/"issue") — 호출한 화면의 카탈로그에서 온다.
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
  // 워크스페이스 멤버면 얼굴이 노드가 되고, 아니면(시스템 주체) 사건 아이콘이 노드가 된다.
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
      href={`/${workspace}/scorecards/${encodeURIComponent(scorecardId)}`}
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

  // 사건 하나를 "아이콘 · 문장 · 값 칩"으로 옮긴다. 문장은 항상 짧게 두고(무엇을 했는가), 달라진 값은
  // 전부 칩으로 뺀다 — 값이 문장 안에 박히면 한국어/영어의 어순과 조사에 끌려다니게 된다.
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
          // 연결을 끊은 항목도 출처를 그대로 들고 있다 — 끊긴 건 동기화지 유래가 아니다.
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
              <StatusMove kind={kind} from={detailString(detail, 'from')} to={to} />
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
              <StatusMove kind={kind} from={detailString(detail, 'from')} to={to} />
              {causeChip}
              {scorecardChip}
            </>
          ),
        }
      }
      case 'completed': {
        // 열린 이슈를 남긴 채 닫은 완료는 "기한을 지켰다"가 아니라 "강행했다"로 읽혀야 한다.
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
        // 프로젝트/이니셔티브가 어떤 상태라고 말했는지 — 판정은 배지로, 문장은 업데이트 타임라인이 갖는다.
        const health = detailString(detail, 'health')
        return {
          icon: Megaphone,
          tone: health === 'off_track' ? 'danger' : health === 'at_risk' ? 'warning' : 'success',
          text: t('history.updatePosted'),
          values: health ? <Badge tone="outline">{t(`health.${health}`)}</Badge> : null,
        }
      }
      case 'moved': {
        // 팀 이동은 이름이 바뀌는 유일한 사건이다 — 어느 이름에서 어느 이름으로 갔는지가 이 줄의 전부다.
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
        // 제어 평면이 이 웹보다 먼저 새 사건을 쓰기 시작한 경우 — 줄을 빠뜨리느니 원문 그대로 남긴다.
        return { icon: History, tone: 'neutral', text: entry.event, values: null }
    }
  }
}

// from → to. 옮겨 간 쪽(to)이 결론이라 화살표 뒤에 둔다. 한쪽만 읽히면 그 한쪽만 그린다.
function StatusMove({
  kind,
  from,
  to,
}: {
  kind: TrackerKind
  from: string | undefined
  to: string | undefined
}) {
  if (from === undefined && to === undefined) return null
  return (
    <span className="inline-flex items-center gap-1">
      {from !== undefined && <StatusChip kind={kind} value={from} />}
      {from !== undefined && to !== undefined && (
        <ArrowRight className="size-3 shrink-0 text-faint" aria-hidden />
      )}
      {to !== undefined && <StatusChip kind={kind} value={to} />}
    </span>
  )
}

// 상태 칩은 목록·상세에서 쓰는 그 배지 그대로다 — 이력에서만 다른 모양을 쓰면 같은 상태가 화면마다 달라진다.
// 이력의 detail 은 검증되지 않은 자유 값이라, 어휘에 없는 문자열은 원문 칩으로 떨어진다.
function StatusChip({ kind, value }: { kind: TrackerKind; value: string }) {
  if (kind === 'issue') {
    const parsed = issueStatusSchema.safeParse(value)
    if (parsed.success) return <IssueStatusBadge status={parsed.data} />
  }
  if (kind === 'project') {
    const parsed = projectStatusSchema.safeParse(value)
    if (parsed.success) return <ProjectStatusBadge status={parsed.data} />
  }
  if (kind === 'initiative') {
    const parsed = initiativeStatusSchema.safeParse(value)
    if (parsed.success) return <InitiativeStatusBadge status={parsed.data} />
  }
  return <Badge tone="outline">{value}</Badge>
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

// 배지 톤(outline 포함)을 피드 톤으로 옮긴다 — outline 은 색 없는 중립이다.
function toTone<T>(
  parsed: { success: true; data: T } | { success: false },
  toneOf: (value: T) => 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'outline'
): ActivityTone {
  if (!parsed.success) return 'neutral'
  const tone = toneOf(parsed.data)
  return tone === 'outline' ? 'neutral' : tone
}

// 링크 대상 — 자산 종류(faint)와 id@version. 대상 화면으로 그대로 걸어 들어갈 수 있다.
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
  // 끊긴 링크는 더 이상 갈 곳이 아니다 — 칩만 남기고 주소는 걸지 않는다.
  if (!linked) return chip
  return (
    <Link
      href={issueLinkHref(workspace, type, id)}
      className="transition-colors hover:text-foreground"
    >
      {chip}
    </Link>
  )
}

// GitHub 원본 — owner/repo#12. 도메인이 이력 detail 에 주소(url)까지 자족적으로 남기므로, 라이브 연결을
// 끊은 뒤에도 "어디서 가져왔는지"를 여기서 바로 열 수 있다. url 이 없는 예전 항목은 텍스트로만 남는다
// (github.com 이라 가정하고 주소를 지어내지 않는다 — GHE 사본이면 틀린 곳으로 보낸다).
function RepoChip({
  detail,
  fallback,
}: {
  detail: Record<string, unknown> | undefined
  // 구조화된 출처가 없는 예전 항목이 들고 있는 문자열(`owner/repo#42`) — 있으면 텍스트로라도 보여준다.
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
