import type { ReactNode } from 'react'
import { Boxes, Cpu, Database, ListFilter, Server, Tag } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { fmtPct } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// 메트릭 요약 칩 — 이름(faint) + 평균 + 선택적 통과율. 목록/하니스별에서 동일하게.
export function MetricChip({
  metric,
  mean,
  passRate,
}: {
  metric: string
  mean: number
  passRate?: number | null
}) {
  return (
    <code className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
      <span className="text-faint">{metric}</span>
      <span className="tabular-nums text-foreground/85">{mean.toFixed(2)}</span>
      {passRate != null && <span className="tabular-nums text-faint">· {fmtPct(passRate)}</span>}
    </code>
  )
}

// 모델 칩 — 하니스가 쓴/선언한 LLM 식별자. 종류 식별용 아이콘(Cpu)을 앞에 붙인다(텍스트만으로는 구별 어려움).
// primary=bg-secondary(강조), muted=관측/선언(옅음). 전역 통일.
export function ModelChip({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <code
      className={cn(
        'inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px]',
        muted ? 'bg-muted/40 text-muted-foreground' : 'bg-secondary text-secondary-foreground'
      )}
    >
      <Cpu
        className={cn('size-3 shrink-0', muted ? 'text-muted-foreground/70' : 'text-[#fc9a6e]')}
      />
      {children}
    </code>
  )
}

// 런타임 칩 — 워크로드가 도는 실행 인프라(등록 런타임 id | self:* 러너 | '기본 백엔드'). 아이콘(Server)으로 종류 구별.
export function RuntimeChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      <Server className="size-3 shrink-0 text-[#6ec6a8]" />
      {label}
    </span>
  )
}

// 부분 실행 칩 — 데이터셋의 subset 만 돌린 스코어카드 표식(selected/total). 전체 실행이면 렌더하지 않는다.
export function SubsetChip({ selected, total }: { selected: number; total: number }) {
  const t = useTranslations('ui')
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground"
      title={t('subsetTitle', { total, selected })}
    >
      <ListFilter className="size-3 shrink-0 text-[#e2b96b]" />
      {t('subsetLabel', { selected, total })}
    </span>
  )
}

// 버전 태그 칩 — 버전을 번호만으로 분간하기 어려울 때 붙이는 자유 라벨(스펙 밖 레지스트리 메타). 전역 통일.
// trailing(삭제 ✕ 등)은 편집 표면이 주입한다 — 칩 자체는 표시 전용.
export function VersionTagChip({
  children,
  trailing,
}: {
  children: ReactNode
  trailing?: ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <Tag className="size-3 shrink-0 text-[#b78de8]" />
      {children}
      {trailing}
    </span>
  )
}

// id@version 참조 — 데이터셋/하니스 식별을 동일 서식으로(@version 은 faint).
// kind 를 주면 종류 아이콘을 앞에 붙여 눈으로 구별(데이터셋=Database 블루, 하니스=Boxes 인디고).
const ENTITY_META = {
  dataset: { icon: Database, tint: 'text-[#7cc0ff]' },
  harness: { icon: Boxes, tint: 'text-[#9aa2ec]' },
} as const

export function EntityRef({
  id,
  version,
  kind,
}: {
  id: string
  version?: string
  kind?: keyof typeof ENTITY_META
}) {
  const meta = kind ? ENTITY_META[kind] : null
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono">
      {meta && <meta.icon className={cn('size-3.5 shrink-0', meta.tint)} strokeWidth={1.75} />}
      <span className="truncate">
        {id}
        {version && <span className="text-faint">@{version}</span>}
      </span>
    </span>
  )
}
