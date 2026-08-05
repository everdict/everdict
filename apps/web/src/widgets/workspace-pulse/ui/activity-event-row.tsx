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

// 이벤트 kind 는 `<주체>.<동사>` 문법이다(agent.run.started 처럼 주체가 두 마디인 경우가 있어 **마지막 점**
// 에서 자른다). 문장을 kind 마다 한 벌씩 번역하는 대신 주체와 동사를 각각 번역해 칩으로 세우는 이유:
//   ① 60개가 넘는 kind 마다 두 로케일의 문장을 유지하는 일은 새 kind 가 추가될 때마다 조용히 밀린다,
//   ② 한국어는 값을 문장에 끼워 넣는 순간 조사가 값에 따라 달라진다 — 그래서 값은 언제나 칩이다
//      (`shared/ui/activity-feed` 가 이미 그렇게 정한 규칙).
// 모르는 토큰은 원문 그대로 둔다: 새 배포가 기록한 사실을 옛 리더가 감추는 것보다 낫다.
function splitKind(kind: string): { subject: string; verb: string } {
  const at = kind.lastIndexOf('.')
  if (at < 0) return { subject: catalogKey(kind), verb: '' }
  return { subject: catalogKey(kind.slice(0, at)), verb: catalogKey(kind.slice(at + 1)) }
}

// 카탈로그 키로 쓸 수 있는 토큰. next-intl 은 키의 점을 **중첩 경로**로 읽으므로 `agent.run` 을 그대로
// 조회하면 `activitySubject → agent → run` 을 찾다가 언제나 실패한다(라이브에서 이 줄만 영문 원문
// "agent.run" 으로 나왔다). 두 마디짜리 주체는 밑줄로 눕혀서 한 칸짜리 키로 만든다.
function catalogKey(token: string): string {
  return token.replaceAll('.', '_')
}

// 어느 축의 사실인가 — 아이콘 하나로 "이건 일 얘기 / 평가 얘기"가 구분된다. 서버가 계약에 박아 둔 축 분류와
// 같은 갈래(@everdict/contracts `activityAxisOf`)지만, 여기서는 아이콘을 고르는 데만 쓰므로 접두사로 판단한다.
function iconOf(kind: string): LucideIcon {
  if (kind.startsWith('agent.') || kind.startsWith('approval.')) return Bot
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

// 색은 사실의 성격에만 쓴다 — 무너진 것/끝난 것/그 외. 판단은 하지 않는다(계약이 사실만 기록하는 것과 같은 이유).
function toneOf(kind: string): ActivityTone {
  if (kind.endsWith('.failed') || kind.endsWith('.exceeded') || kind.endsWith('.circuit_opened'))
    return 'danger'
  if (kind.endsWith('.threshold_crossed') || kind.endsWith('.placement_blocked')) return 'warning'
  if (kind.endsWith('.completed') || kind.endsWith('.approved')) return 'success'
  return 'neutral'
}

// 주체 타입 → 그 하나가 사는 주소. 여기 없는 타입(파일·지식·태스크·승인·대화)은 링크하지 않는다: 갈 곳이
// 없는 링크는 없는 것만 못하고, 그 화면들은 id 하나로 열리지 않는다.
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

// 그 사실이 가리키는 것을 사람이 **부르는 손잡이**(식별자·이름·경로) — 짧고 인용 가능한 값만. 페이로드는
// 검증되지 않은 가방이라(트래커 이력의 `history-detail` 과 같은 규칙) 문자열이 아닌 값은 없는 것으로 친다.
// 손잡이가 없으면 아무것도 그리지 않는다 — 예전에는 `subject.id` 를 그렸는데, 그건 36자짜리 uuid 라서
// 줄마다 읽을 수 없는 문자열이 붙었다.
const CITE_KEYS = ['identifier', 'name', 'key', 'path', 'agentId'] as const

// 손잡이가 아니라 **문장**인 값 — 이슈 제목, 업데이트/코멘트 발췌, 태스크 제목, 배치 거절 사유. 손잡이는
// mono 로, 문장은 본문 서체로: 두 부류를 한 칸에 섞으면 어느 쪽도 읽히지 않는다.
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

// `.status_changed` 의 from→to 를 목록과 같은 상태 배지로 그릴 수 있는 주체들.
function trackerKindOf(subjectType: string): TrackerKind | undefined {
  return subjectType === 'issue' || subjectType === 'project' || subjectType === 'initiative'
    ? subjectType
    : undefined
}

// `id@version` 문자열(run/scorecard 페이로드의 harness·dataset 표기) 또는 맨 id → EntityRef 칩.
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

// 짧은 기계 손잡이(케이스 id·도구 이름·경로) — 인용 칸과 같은 mono 처리.
function MonoChip({ value }: { value: string | undefined }) {
  if (value === undefined) return null
  return (
    <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{value}</span>
  )
}

// 자유 배지 두 개로 그리는 from → to (상태 어휘 밖의 이동 — 이슈의 팀 이동 식별자 등).
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

// 홈 활동 피드의 한 줄 — "누가 · 무엇을 · 어떻게 됐다"가 payload 의 재료로 읽히게 한다. 문장은 여전히
// 주체·동사 어휘의 조합이지만(위 splitKind 의 이유), 사실의 **내용**은 값 칩으로 선다: 상태는 from→to
// 배지, 배치는 합격률, 파일은 경로, 승인은 결정. 재료가 하나도 없는 이벤트만 서버가 지은 영문 한 줄
// (`message`)로 눕는다 — 아무것도 안 보이는 줄보다는 원문이 낫다.
export function ActivityEventRow({
  event,
  workspace,
  directory,
  locale,
  timeZone,
}: {
  event: PlatformEvent
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
  // 인용도 칩도 없는 줄만 message 로 폴백 — 있는 줄에 원문까지 겹치면 같은 말이 두 번 선다.
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
      {/* 사실의 한 줄 원문(서버가 만든 영문 데이터)은 title 로 — 화면의 문장은 언제나 번역된
          어휘이고, 원문은 정확히 무엇이 기록됐는지 확인하고 싶을 때만 필요하다. */}
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
      {values}
      {cited !== undefined && <MonoChip value={cited} />}
      {quote !== undefined && (
        <span className="min-w-0 truncate text-[12px] text-muted-foreground" title={quote}>
          {quote}
        </span>
      )}
    </ActivityRow>
  )

  // kind 별 값 칩 — payload 가 실은 재료를 사람이 읽는 모양으로. 트래커 이력의 describe() 와 같은 원칙:
  // 문장은 짧게, 달라진 값은 전부 칩으로. 모양이 어긋난 payload 는 그 칩만 조용히 사라진다.
  function chips(): ReactNode | null {
    const kind = event.kind

    // 상태 전이 — 트래커 세 종은 목록과 같은 상태 배지로, 그 밖의 주체는 자유 배지로 from→to 를 그린다.
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
    // 팀 이동은 식별자가 바뀌는 사건이다 — 어느 이름에서 어느 이름으로 갔는지가 이 줄의 전부다.
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
    // 등록·이관된 능력 — id(@version)를 그 종류의 아이콘으로. 종류 밖 주체(scorecard.moved 의 팀 uuid)는
    // 그리지 않는다: 읽을 수 없는 값은 없는 것만 못하다.
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
