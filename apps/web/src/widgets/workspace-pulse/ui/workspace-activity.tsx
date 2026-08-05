import { BookOpen, Bot, CircleDot, FlaskConical, History, type LucideIcon } from 'lucide-react'
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server'

import { memberDirectoryOf, membersSchema } from '@/entities/member'
import { platformEventListSchema, type PlatformEvent } from '@/entities/platform-event'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { ActivityFeed, ActivityRow, type ActivityTone } from '@/shared/ui/activity-feed'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { SectionHeader } from '@/shared/ui/section-header'

// 활동 — 이 워크스페이스에 실제로 기록된 사실들. 평가만이 아니라 이슈·사이클·목표·에이전트·파일·지식까지
// 한 줄기로 흐른다. 홈이 "평가 전용 화면"으로 읽히던 이유의 절반이 이 피드가 없었다는 것이다.
const FEED_LIMIT = 14

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

// 그 사실이 가리키는 것을 사람이 **부르는 이름**. 페이로드는 검증되지 않은 가방이라(트래커 이력의
// `history-detail` 과 같은 규칙) 문자열이 아닌 값은 없는 것으로 친다.
//
// 이름이 없으면 아무것도 그리지 않는다 — 예전에는 `subject.id` 를 그렸는데, 그건 36자짜리 uuid 라서 줄마다
// 읽을 수 없는 문자열이 붙었다. 무엇에 대한 사실인지는 어차피 링크가 데려가서 알려 준다.
function citationOf(payload: Record<string, unknown>): string | undefined {
  for (const key of ['identifier', 'name', 'title', 'subject'] as const) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

export async function WorkspaceActivity({ workspace }: { workspace: string }) {
  const t = await getTranslations('overviewPage')
  const locale = await getLocale()
  const timeZone = await getTimeZone()
  const ctx = await authContext()

  // 이벤트 로그가 없는 배포도 있다(그리고 events:read 가 없는 역할도) — 피드가 없다고 홈이 깨지지는 않는다.
  const [events, members] = await Promise.all([
    controlPlane
      .listPlatformEvents(ctx, FEED_LIMIT)
      .then((r) => platformEventListSchema.parse(r).events)
      .catch(() => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => []),
  ])
  const directory = memberDirectoryOf(members)

  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('activityTitle')} />
      {events.length === 0 ? (
        <EmptyState
          icon={<History />}
          title={t('activityEmptyTitle')}
          hint={t('activityEmptyHint')}
        />
      ) : (
        <div className="rounded-lg border bg-card p-3.5 shadow-raise">
          <ActivityFeed>
            {events.map((event) => {
              const { subject, verb } = splitKind(event.kind)
              const actor = event.actor === undefined ? undefined : directory[event.actor]
              const href = hrefOf(workspace, event)
              const cited = citationOf(event.payload)
              const noun = t.has(`activitySubject.${subject}`)
                ? t(`activitySubject.${subject}`)
                : subject
              return (
                <ActivityRow
                  key={event.id}
                  {...(actor ? { actor } : {})}
                  icon={iconOf(event.kind)}
                  tone={toneOf(event.kind)}
                  at={event.createdAt}
                  locale={locale}
                  timeZone={timeZone}
                >
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
                  {cited !== undefined && (
                    <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                      {cited}
                    </span>
                  )}
                </ActivityRow>
              )
            })}
          </ActivityFeed>
        </div>
      )}
    </section>
  )
}
