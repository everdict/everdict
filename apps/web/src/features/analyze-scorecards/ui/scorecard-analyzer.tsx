'use client'

import { useEffect, useMemo, useState } from 'react'

import type { ScorecardRecord } from '@/entities/scorecard'
import { fmtScore, rateHealth, HEALTH_TEXT, fmtSubject } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'

import {
  type AnalysisConfig,
  type GridResult,
  type LineResult,
  DIMENSION_LABEL,
  computeAnalysis,
} from '../model/analysis'

type Author = { name: string; avatarUrl?: string }

// 사용자에게 노출하는 "질문"은 3개뿐 — 나머지 피벗 설정은 각 질문이 내부적으로 고정한다.
export type QuestionId = 'trend' | 'models' | 'harnesses'
const QUESTIONS: { id: QuestionId; label: string; desc: string; pick: 'harness' | null }[] = [
  {
    id: 'trend',
    label: '성능 추이',
    desc: '하니스를 고르면 지난 20일 벤치마크별 점수 변화를 봐요.',
    pick: 'harness',
  },
  {
    id: 'models',
    label: '모델 비교',
    desc: '같은 하니스에서 모델만 바꿨을 때 벤치마크별 성능을 비교해요.',
    pick: 'harness',
  },
  {
    id: 'harnesses',
    label: '하니스 비교',
    desc: '벤치마크마다 하니스들의 성능을 한눈에 비교해요.',
    pick: null,
  },
]

const TREND_DAYS = 20

function buildConfig(q: QuestionId, harness: string, nowIso: string): AnalysisConfig {
  const base: AnalysisConfig = {
    filters: {},
    groupBy: [],
    measure: 'passRate',
    sort: { by: 'label', dir: 'asc' },
    viz: 'table',
  }
  if (q === 'trend') {
    const from = new Date(new Date(nowIso).getTime() - TREND_DAYS * 86_400_000).toISOString().slice(0, 10)
    return {
      ...base,
      filters: { harness: harness ? [harness] : undefined, from },
      groupBy: ['day', 'dataset'],
      viz: 'line',
    }
  }
  if (q === 'models') {
    return {
      ...base,
      filters: { harness: harness ? [harness] : undefined },
      groupBy: ['model'],
      pivotBy: 'dataset',
    }
  }
  // harnesses — 벤치마크(행) × 하니스(열)
  return { ...base, groupBy: ['dataset'], pivotBy: 'harness' }
}

function scoreCell(value: number | undefined) {
  if (value === undefined) return <span className="text-faint">–</span>
  const health = rateHealth(value <= 1 ? value : null)
  return <span className={cn('font-[560] tabular-nums', HEALTH_TEXT[health])}>{fmtScore(value, value)}</span>
}

// 벤치마크별 추이 라인(벤치마크당 1선).
function LineChart({ result }: { result: LineResult }) {
  const W = 720
  const H = 200
  const pad = { l: 8, r: 8, t: 12, b: 22 }
  const all = result.series.flatMap((s) => s.points).filter((v): v is number => v !== undefined)
  const max = Math.max(1, ...all)
  const min = Math.min(0, ...all)
  const span = max - min || 1
  const n = result.buckets.length
  const x = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1))
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b)
  const COLORS = ['var(--color-primary)', 'var(--color-success)', 'var(--color-warning)', '#4ea7ff', '#eb5757', '#a78bfa']
  return (
    <div className="space-y-2 overflow-x-auto rounded-lg border bg-card p-4 shadow-raise">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-52 w-full min-w-[520px]" role="img" aria-label="점수 추이">
        {result.series.map((s, si) => {
          const pts = s.points
            .map((v, i) => (v === undefined ? null : `${x(i)},${y(v)}`))
            .filter(Boolean)
            .join(' ')
          return (
            <g key={s.label}>
              <polyline points={pts} fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth={2} strokeLinejoin="round" />
              {s.points.map((v, i) =>
                v === undefined ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={COLORS[si % COLORS.length]} />
                )
              )}
            </g>
          )
        })}
        {result.buckets.map((b, i) => (
          <text key={b} x={x(i)} y={H - 6} textAnchor="middle" className="fill-[var(--color-faint)] text-[9px]">
            {b.slice(5)}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {result.series.map((s, si) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-muted-foreground">
            <span className="inline-block size-2 rounded-full" style={{ background: COLORS[si % COLORS.length] }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// 그리드(표) — 그룹 행 + 피벗 열 + 통과율 셀.
function GridTable({ result, config }: { result: GridResult; config: AnalysisConfig }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card shadow-raise">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-faint">
            {config.groupBy.map((d) => (
              <th key={d} className="px-3 py-2 font-[510]">
                {DIMENSION_LABEL[d]}
              </th>
            ))}
            {result.pivotKeys.length > 0 ? (
              result.pivotKeys.map((pk) => (
                <th key={pk} className="px-3 py-2 text-right font-[510]">
                  {pk}
                </th>
              ))
            ) : (
              <th className="px-3 py-2 text-right font-[510]">통과율</th>
            )}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.key} className="border-b border-border/60 last:border-0 hover:bg-elevated">
              {r.labels.map((l, i) => (
                <td key={i} className="px-3 py-2 font-[510] text-foreground">
                  {l || '—'}
                </td>
              ))}
              {result.pivotKeys.length > 0 ? (
                r.cells.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right">
                    {scoreCell(c.value)}
                  </td>
                ))
              ) : (
                <td className="px-3 py-2 text-right">{scoreCell(r.value)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 스코어카드 분석 — 구체적 질문 3개(추이·모델 비교·하니스 비교)만 아주 쉽게.
export function ScorecardAnalyzer({
  scorecards,
  authors,
  nowIso,
  initialQuestion,
  initialHarness,
}: {
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  nowIso: string
  initialQuestion: QuestionId
  initialHarness: string
}) {
  const harnesses = useMemo(
    () => [...new Set(scorecards.map((s) => s.harness.id))].sort(),
    [scorecards]
  )
  const [q, setQ] = useState<QuestionId>(initialQuestion)
  const [harness, setHarness] = useState<string>(initialHarness || harnesses[0] || '')

  useEffect(() => {
    const p = new URLSearchParams({ q })
    if (q !== 'harnesses' && harness) p.set('h', harness)
    window.history.replaceState(null, '', `?${p.toString()}`)
  }, [q, harness])

  const resolveOwner = (s: string) => authors[s]?.name ?? (s ? fmtSubject(s) : '—')
  const question = QUESTIONS.find((x) => x.id === q) ?? QUESTIONS[0]
  const config = buildConfig(q, harness, nowIso)
  const result = useMemo(
    () => computeAnalysis(scorecards, config, resolveOwner),
    [scorecards, config, authors]
  )

  return (
    <div className="space-y-4">
      {/* 질문 선택 */}
      <div className="grid gap-2 sm:grid-cols-3">
        {QUESTIONS.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setQ(x.id)}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              q === x.id
                ? 'border-primary/50 bg-primary/8 shadow-raise'
                : 'border-border bg-card hover:border-border-strong'
            )}
          >
            <div className="text-[14px] font-[560] text-foreground">{x.label}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{x.desc}</div>
          </button>
        ))}
      </div>

      {/* 최소 입력 — 하니스 선택(추이·모델 비교만) */}
      {question.pick === 'harness' && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">하니스</span>
          <Combobox
            options={harnesses.map((h) => ({ value: h, label: h }))}
            value={harness}
            onChange={setHarness}
            placeholder="하니스 선택"
            className="w-[220px]"
            emptyText="하니스가 없어요"
          />
        </div>
      )}

      {/* 결과 */}
      {result.total === 0 ? (
        <EmptyState
          title="분석할 데이터가 없어요."
          hint={
            question.pick === 'harness'
              ? '이 하니스의 완료된 스코어카드가 없어요. 다른 하니스를 골라보세요.'
              : '완료된 스코어카드가 아직 없어요.'
          }
        />
      ) : result.kind === 'line' ? (
        <LineChart result={result} />
      ) : (
        <GridTable result={result} config={config} />
      )}

      <p className="text-[11px] text-faint">
        완료된 스코어카드 {result.total}개 기준 · 통과율 · 현재 데이터로 실시간 집계
        {q === 'trend' ? ` · 최근 ${TREND_DAYS}일` : ''}
      </p>
    </div>
  )
}
