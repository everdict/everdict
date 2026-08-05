import type { ReactNode } from 'react'
import { Bot, GitBranch, UserRound } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { hasLineage, originRefHref, type CapabilityOrigin } from '@/entities/capability-origin'
import {
  issueHref,
  IssueStatusIcon,
  type IssueCapabilityLinkType,
  type IssueSummary,
} from '@/entities/issue'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Link } from '@/shared/ui/link'
import { SectionHeader } from '@/shared/ui/section-header'

import { LinkIssueButton } from './link-issue-button'

// 능력의 리니지 — "이건 왜 있나, 어디서 나왔나". 이슈에서 태어난 저지·데이터셋·하네스가 자기 출처를 말하고,
// 그 능력을 지켜보는 이슈들을 한자리에 모은다.
//
// 왜 한 섹션인가: 이슈에서 태어난 능력은 그 이슈에 자동으로 링크된다. 출처와 연결된 이슈를 따로 그리면
// 같은 이슈가 화면에 두 번 나오고 어느 쪽이 정본인지 답이 없다 — 그래서 출처 이슈는 목록의 첫 줄이 되고
// "여기서 만들어짐" 배지로 구별된다(이슈 상세가 스코어카드를 한 번만 그리는 것과 같은 규칙).
//
// 그릴 게 없으면 섹션 자체가 없다(빈 섹션은 숨긴다).
// `conversationAction` 은 슬롯이다 — "그 대화로 돌아가기" 버튼은 오른쪽 패널(widgets)의 것이고,
// 피처가 위젯을 가져오면 레이어를 거슬러 올라간다. 그래서 위젯을 아는 페이지(app)가 노드를 넘긴다.
export async function CapabilityLineage({
  workspace,
  kind,
  id,
  origin,
  issues,
  createdByLabel,
  createdAt,
  timeZone,
  canLinkIssues,
  conversationAction,
}: {
  workspace: string
  // 이 능력이 무엇이고 무엇으로 불리는가 — 여기서 이슈를 걸 때 그대로 링크가 된다.
  kind: IssueCapabilityLinkType
  id: string
  origin?: CapabilityOrigin
  issues: IssueSummary[]
  createdByLabel?: string
  createdAt?: string
  timeZone: string
  // issues:write — 링크를 만드는 것은 이슈를 고치는 일이다.
  canLinkIssues: boolean
  conversationAction?: ReactNode
}) {
  const t = await getTranslations('capabilityLineage')
  // 아직 아무 이슈도 걸리지 않은 능력에서는 이 섹션이 이슈를 걸 수 있는 유일한 자리다 — 쓸 수 있는 사람에게는
  // 비어 있어도 낸다(빈 섹션 숨김의 예외는 "여기가 유일한 진입"일 때뿐이다).
  if (!hasLineage(origin) && issues.length === 0 && !canLinkIssues) return null

  const from = origin?.from
  const fromHref = from ? originRefHref(workspace, from) : undefined
  // 출처 이슈는 아래 목록에서 뺀다 — 같은 것을 두 줄로 그리지 않는다.
  const originIssueId = from?.type === 'issue' ? from.id : undefined
  const linked = issues.filter((i) => i.id !== originIssueId)
  const actor = origin?.agentName ?? origin?.agentId

  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {from && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3.5 py-2.5 text-[13px]">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <span className="text-muted-foreground">{t('bornFrom')}</span>
            {fromHref ? (
              <Link href={fromHref} className="min-w-0 truncate font-[510] hover:underline">
                {from.label ?? from.id}
              </Link>
            ) : (
              <span className="min-w-0 truncate font-[510]">{from.label ?? from.id}</span>
            )}
            <Badge tone="info">{t(`refType.${from.type}`)}</Badge>
          </div>
        )}

        {/* 누가 만들었나 — 에이전트가 회원을 대신해 만들었으면 에이전트가 저자이고, 그 대화로 돌아갈 수 있다. */}
        {(actor !== undefined || createdByLabel !== undefined) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3.5 py-2.5 text-[13px]">
            {actor !== undefined ? (
              <Bot className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            ) : (
              <UserRound className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            )}
            <span className="text-muted-foreground">{t('createdBy')}</span>
            <span className="min-w-0 truncate font-[510]">{actor ?? createdByLabel}</span>
            {actor !== undefined && createdByLabel !== undefined && (
              <span className="text-[12px] text-faint">
                {t('onBehalfOf', { name: createdByLabel })}
              </span>
            )}
            {createdAt !== undefined && (
              <span
                className="text-[12px] tabular-nums text-faint"
                title={fmtDateTimeFull(createdAt, { timeZone })}
              >
                {fmtDateTime(createdAt, timeZone)}
              </span>
            )}
            {conversationAction !== undefined && (
              <span className="ml-auto">{conversationAction}</span>
            )}
          </div>
        )}

        {origin?.note !== undefined && (
          <p className="px-3.5 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
            {origin.note}
          </p>
        )}

        {/* 이 능력을 건 이슈들. 출처 한 줄과 섞이면 "여기서 태어났다"와 "여기서 쓰인다"가 같은 말로 읽히므로
            제목을 하나 세운다 — 이 목록이 이슈로 건너가는 유일한 길이고, 그 길이 있다는 걸 먼저 말해야 한다.
            거는 자리도 같은 줄이다: 읽는 곳과 더하는 곳이 떨어져 있으면 "여기서도 걸 수 있다"를 아무도 모른다. */}
        {(linked.length > 0 || canLinkIssues) && (
          <div className="flex items-center justify-between gap-2 px-3.5 py-2">
            <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('watching', { count: linked.length })}
            </p>
            <LinkIssueButton
              type={kind}
              capabilityId={id}
              canWrite={canLinkIssues}
              linkedIssueIds={issues.map((issue) => issue.id)}
            />
          </div>
        )}
        {linked.map((issue) => (
          <Link
            key={issue.id}
            href={issueHref(workspace, issue.identifier, issue.title)}
            className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-elevated"
          >
            <IssueStatusIcon status={issue.status} />
            <code className="shrink-0 font-mono text-[12px] text-faint">{issue.identifier}</code>
            <span className="min-w-0 truncate">{issue.title}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
