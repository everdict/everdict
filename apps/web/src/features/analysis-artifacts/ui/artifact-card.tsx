import { BarChart3, FileText, Pin, Table2 } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import {
  chartSpecSchema,
  reportSpecSchema,
  tableSpecSchema,
  type AnalysisArtifact,
  type ChartSpec,
  type TableSpec,
} from '@/entities/analysis-artifact'
import { Markdown } from '@/shared/ui/markdown'

// One rendered analysis artifact (chart | table | report) — declarative data only, drawn by OUR components
// (the agent's output is never injected as HTML; analysis-studio principle 2). The opaque `spec` is validated
// per kind here and degrades to a note on a mismatch instead of crashing the page.

const COLORS = [
  'var(--color-primary)',
  'var(--color-success)',
  'var(--color-warning)',
  '#4ea7ff',
  '#eb5757',
  '#a78bfa',
]

function formatY(v: number, unit: ChartSpec['yUnit']): string {
  if (unit === 'ratio') return `${Math.round(v * 100)}%`
  if (unit === 'usd') return `$${v.toFixed(v < 1 ? 3 : 2)}`
  if (unit === 'seconds') return `${v.toFixed(1)}s`
  return `${Math.round(v * 100) / 100}`
}

// Hand-rolled SVG (the analyze-dashboard idiom — no chart library): line = one polyline per series,
// bar = grouped columns per x label.
function ChartView({ spec, ariaLabel }: { spec: ChartSpec; ariaLabel: string }) {
  const W = 720
  const H = 200
  const pad = { l: 8, r: 8, t: 12, b: 22 }
  const all = spec.series.flatMap((s) => s.points).filter((v): v is number => v !== null)
  const max = Math.max(1e-9, ...all)
  const min = Math.min(0, ...all)
  const span = max - min || 1
  const n = spec.x.length
  const innerW = W - pad.l - pad.r
  const x = (i: number) => pad.l + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1))
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b)

  return (
    <div className="space-y-2 overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-52 w-full min-w-[520px]"
        role="img"
        aria-label={ariaLabel}
      >
        {spec.type === 'line'
          ? spec.series.map((s, si) => {
              const pts = s.points
                .map((v, i) => (v === null || v === undefined ? null : `${x(i)},${y(v)}`))
                .filter(Boolean)
                .join(' ')
              return (
                <g key={s.label}>
                  <polyline
                    points={pts}
                    fill="none"
                    stroke={COLORS[si % COLORS.length]}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                  {s.points.map((v, i) =>
                    v === null || v === undefined ? null : (
                      <circle
                        key={i}
                        cx={x(i)}
                        cy={y(v)}
                        r={2.5}
                        fill={COLORS[si % COLORS.length]}
                      />
                    )
                  )}
                </g>
              )
            })
          : spec.x.map((_, i) => {
              // Grouped bars: the slot around each x label is shared by the series, side by side.
              const slot = n > 0 ? innerW / n : innerW
              const groupW = slot * 0.72
              const barW = groupW / spec.series.length
              const left = pad.l + i * slot + (slot - groupW) / 2
              return (
                <g key={i}>
                  {spec.series.map((s, si) => {
                    const v = s.points[i]
                    if (v === null || v === undefined) return null
                    const top = y(Math.max(v, 0))
                    const bottom = y(Math.min(v, 0))
                    return (
                      <rect
                        key={s.label}
                        x={left + si * barW}
                        y={top}
                        width={Math.max(1, barW - 1)}
                        height={Math.max(1, bottom - top || 1)}
                        rx={1.5}
                        fill={COLORS[si % COLORS.length]}
                      />
                    )
                  })}
                </g>
              )
            })}
        {spec.x.map((label, i) => (
          <text
            key={`${label}-${i}`}
            x={spec.type === 'line' ? x(i) : pad.l + (i + 0.5) * (innerW / Math.max(1, n))}
            y={H - 6}
            textAnchor="middle"
            className="fill-[var(--color-faint)] text-[9px]"
          >
            {label.length > 10 ? `${label.slice(0, 9)}…` : label}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {spec.series.map((s, si) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-muted-foreground">
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: COLORS[si % COLORS.length] }}
            />
            {s.label}
          </span>
        ))}
        {spec.yUnit && spec.yUnit !== 'raw' && all.length > 0 && (
          <span className="text-muted-foreground/70">
            {formatY(min, spec.yUnit)} – {formatY(max, spec.yUnit)}
          </span>
        )}
      </div>
    </div>
  )
}

function TableView({ spec }: { spec: TableSpec }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {spec.columns.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border/50 last:border-0">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-2 py-1.5 ${typeof cell === 'number' ? 'tabular-nums' : ''}`}
                >
                  {cell === null
                    ? '—'
                    : typeof cell === 'number'
                      ? Math.round(cell * 1000) / 1000
                      : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const KIND_ICON = { chart: BarChart3, table: Table2, report: FileText } as const

export async function ArtifactCard({ artifact }: { artifact: AnalysisArtifact }) {
  const t = await getTranslations('analysisArtifacts')
  const format = await getFormatter()
  const Icon = KIND_ICON[artifact.kind]

  let body: React.ReactNode
  if (artifact.kind === 'chart') {
    const spec = chartSpecSchema.safeParse(artifact.spec)
    body = spec.success ? (
      <ChartView spec={spec.data} ariaLabel={artifact.title} />
    ) : (
      <p className="text-sm text-muted-foreground">{t('invalidSpec')}</p>
    )
  } else if (artifact.kind === 'table') {
    const spec = tableSpecSchema.safeParse(artifact.spec)
    body = spec.success ? (
      <TableView spec={spec.data} />
    ) : (
      <p className="text-sm text-muted-foreground">{t('invalidSpec')}</p>
    )
  } else {
    const spec = reportSpecSchema.safeParse(artifact.spec)
    body = spec.success ? (
      <Markdown content={spec.data.markdown} className="prose-sm" />
    ) : (
      <p className="text-sm text-muted-foreground">{t('invalidSpec')}</p>
    )
  }

  return (
    <article className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-medium">{artifact.title}</h3>
          {artifact.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
        </div>
        <time className="shrink-0 text-xs text-muted-foreground" dateTime={artifact.createdAt}>
          {format.dateTime(new Date(artifact.createdAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </time>
      </header>
      {body}
    </article>
  )
}
