'use client'

import { BarChart3, FileText, LayoutDashboard, Pin, Table2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import {
  BarChart,
  LineChart,
  MAX_SERIES,
  seriesColorAt,
  type ChartSeries,
} from '@/shared/ui/charts'
import { Markdown } from '@/shared/ui/markdown'
import { TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import {
  chartSpecSchema,
  htmlSpecSchema,
  reportSpecSchema,
  tableSpecSchema,
  type AnalysisArtifact,
  type ChartSpec,
  type HtmlSpec,
  type TableSpec,
} from '../model/schema'

// One rendered analysis artifact (chart | table | report) — declarative data only, drawn by OUR components
// (the agent's output is never injected as HTML; analysis-studio principle 2). The opaque `spec` is validated
// per kind here and degrades to a note on a mismatch instead of crashing the page.

function formatY(v: number, unit: ChartSpec['yUnit']): string {
  if (unit === 'ratio') return `${Math.round(v * 100)}%`
  if (unit === 'usd') return `$${v.toFixed(v < 1 ? 3 : 2)}`
  if (unit === 'seconds') return `${v.toFixed(1)}s`
  return `${Math.round(v * 100) / 100}`
}

// An agent-emitted chart is drawn by the SAME components the analysis canvas uses — a pinned artifact and
// the board it came from must not look like two different products. The spec allows more series than the
// palette has slots, and the tail is disclosed rather than given invented hues.
function ChartView({ spec, ariaLabel }: { spec: ChartSpec; ariaLabel: string }) {
  const t = useTranslations('analysisArtifacts')
  const shown = spec.series.slice(0, MAX_SERIES)
  const hidden = spec.series.length - shown.length
  const series: ChartSeries[] = shown.map((s, i) => ({
    key: s.label,
    label: s.label,
    color: seriesColorAt(i),
  }))
  const values = shown.map((s) => s.points)
  const format = (v: number) => formatY(v, spec.yUnit)
  // A ratio is always framed against 0–100%, so two artifacts of the same metric stay comparable.
  const domain = spec.yUnit === 'ratio' ? { min: 0, max: 1 } : undefined
  const common = {
    x: spec.x,
    series,
    values,
    formatValue: format,
    ariaLabel,
    emptyLabel: t('chartEmpty'),
    ...(domain ? { domain } : {}),
  }

  return (
    <div className="space-y-2">
      {spec.type === 'line' ? <LineChart {...common} /> : <BarChart {...common} />}
      {hidden > 0 && <p className="text-[11px] text-faint">{t('seriesCapped', { hidden })}</p>}
    </div>
  )
}

// Free-form agent-authored visualization — the Claude-Artifacts model. The markup executes ONLY inside an
// opaque-origin sandboxed iframe (`sandbox="allow-scripts"` WITHOUT allow-same-origin: no parent DOM, no
// cookies/storage of ours) and our shell injects a deny-all CSP (default-src 'none') so no network request —
// load or exfiltration — can leave it. Inline <style>/<script>/SVG/canvas only, which is exactly the contract
// the render_html tool states.
function HtmlView({ spec, title }: { spec: HtmlSpec; title: string }) {
  const shell =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:;\">" +
    '<style>:root{color-scheme:light dark}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px}</style>' +
    `</head><body>${spec.html}</body></html>`
  return (
    <iframe
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={shell}
      title={title}
      className="w-full rounded-md border border-border/60 bg-background"
      style={{ height: Math.min(Math.max(spec.height ?? 480, 160), 1600) }}
    />
  )
}

// The card already supplies the surface, so this uses the table atoms WITHOUT the bordered container —
// same header/row treatment as every other table in the app, no nested card edge.
function TableView({ spec }: { spec: TableSpec }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <THead>
          <tr>
            {spec.columns.map((c) => (
              <TH key={c}>{c}</TH>
            ))}
          </tr>
        </THead>
        <TBody>
          {spec.rows.map((row, ri) => (
            <TR key={ri}>
              {row.map((cell, ci) => (
                <TD key={ci} className={typeof cell === 'number' ? 'tabular-nums' : undefined}>
                  {cell === null
                    ? '—'
                    : typeof cell === 'number'
                      ? Math.round(cell * 1000) / 1000
                      : cell}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </table>
    </div>
  )
}

const KIND_ICON = {
  chart: BarChart3,
  table: Table2,
  report: FileText,
  html: LayoutDashboard,
} as const

export function ArtifactCard({
  artifact,
  action,
}: {
  artifact: AnalysisArtifact
  action?: React.ReactNode
}) {
  const t = useTranslations('analysisArtifacts')
  const format = useFormatter()
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
  } else if (artifact.kind === 'html') {
    const spec = htmlSpecSchema.safeParse(artifact.spec)
    body = spec.success ? (
      <HtmlView spec={spec.data} title={artifact.title} />
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
        <div className="flex shrink-0 items-center gap-1">
          <time className="text-xs text-muted-foreground" dateTime={artifact.createdAt}>
            {format.dateTime(new Date(artifact.createdAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </time>
          {action}
        </div>
      </header>
      {body}
    </article>
  )
}
