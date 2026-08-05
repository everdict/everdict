'use client'

import { useEffect, useRef, useState } from 'react'
import { BarChart3, FileText, LayoutDashboard, LayoutGrid, Pin, Table2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import {
  BarChart,
  LineChart,
  MAX_SERIES,
  seriesColorAt,
  type ChartSeries,
} from '@/shared/ui/charts'
import { Markdown } from '@/shared/ui/markdown'
import { StatCard } from '@/shared/ui/stat-card'
import { TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import { deltaArrow, metricDelta, type DeltaSentiment } from '../lib/metric-delta'
import {
  chartSpecSchema,
  dashboardSpecSchema,
  htmlSpecSchema,
  reportSpecSchema,
  tableSpecSchema,
  type AnalysisArtifact,
  type ChartSpec,
  type DashboardBlock,
  type DashboardMetric,
  type DashboardSpec,
  type HtmlSpec,
  type TableSpec,
} from '../model/schema'

// One rendered analysis artifact. chart | table | report are declarative data drawn by OUR components — the
// agent picks no pixel (analysis-studio principle 2). `html` is the deliberate escape hatch for a layout the
// three closed kinds cannot express; it keeps the principle in refined form by never running in the app origin
// (see HtmlView) and by taking its whole visual vocabulary from the frame rather than authoring one. The opaque
// `spec` is validated per kind here and degrades to a note on a mismatch instead of crashing the page.

// One formatter for the whole artifact family, so a metric card and the chart plotting the same measure never
// disagree. `precise` is the headline variant: an axis tick wants a round 62%, but a metric card's number must
// carry the decimal its delta was computed from — 62% sitting above "▲ 4.2pt" is the kind of small mismatch
// that makes a dashboard read as assembled rather than designed.
function formatY(v: number, unit: ChartSpec['yUnit'], precise = false): string {
  if (unit === 'ratio') return precise ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`
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
//
// That isolation is also why the frame has to be HANDED the design system: an opaque origin inherits nothing —
// not our stylesheet, not the `html.dark` class, not the font — so a frame given only a blank page leaves the
// model no choice but to invent a palette, and an invented palette is what makes a generated dashboard read as
// a foreign widget pasted into the product. So the shell below publishes the LIVE value of the workspace's
// tokens plus a class vocabulary built from the same parts the app's own surfaces use, and the emission schema
// (`HtmlSpecSchema`) rejects markup that paints with anything else.

// Mirrors ARTIFACT_FRAME_TOKENS in @everdict/contracts — the web may not import a value from a package
// (runtime decoupling), so the two lists are kept in step by hand.
const FRAME_TOKENS = [
  '--foreground',
  '--muted-foreground',
  '--faint',
  '--card',
  '--elevated',
  '--accent',
  '--border',
  '--border-strong',
  '--primary',
  '--link',
  '--success',
  '--warning',
  '--destructive',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-other',
  '--radius',
] as const

// The frame's own stylesheet: the app's type scale, the settings-list/table treatment and the metric+delta
// parts, expressed once so agent markup composes instead of restyling. Every color here is a token, so the
// whole sheet re-themes with the app.
const FRAME_STYLESHEET = [
  '*{box-sizing:border-box}',
  'html,body{height:auto}',
  'body{margin:0;background:transparent;color:var(--foreground);font-size:13px;line-height:1.5;letter-spacing:-0.02em;-webkit-font-smoothing:antialiased}',
  'h1,h2,h3{margin:0 0 8px;font-weight:510;letter-spacing:-0.022em}',
  'h1{font-size:18px}h2{font-size:15px}h3{font-size:13px}',
  'p{margin:0 0 8px}',
  '.muted{color:var(--muted-foreground)}',
  '.faint{color:var(--faint)}',
  '.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(148px,1fr))}',
  '.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
  '.panel{border:1px solid var(--border);border-radius:var(--radius);background:var(--elevated);padding:12px}',
  '.metric{display:flex;flex-direction:column;gap:4px;border:1px solid var(--border);border-radius:var(--radius);background:var(--elevated);padding:10px 12px}',
  '.metric-label{font-size:11px;font-weight:510;text-transform:uppercase;letter-spacing:0.04em;color:var(--faint)}',
  '.metric-value{font-size:24px;font-weight:600;letter-spacing:-0.03em;font-variant-numeric:tabular-nums}',
  '.metric-sub{font-size:12px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}',
  '.delta{display:inline-flex;align-items:center;gap:3px;align-self:flex-start;border-radius:999px;padding:1px 7px;font-size:11px;font-weight:510;font-variant-numeric:tabular-nums}',
  '.delta.up{color:var(--success);background:color-mix(in oklab,var(--success) 14%,transparent)}',
  '.delta.down{color:var(--destructive);background:color-mix(in oklab,var(--destructive) 14%,transparent)}',
  '.delta.flat{color:var(--faint);background:color-mix(in oklab,var(--faint) 14%,transparent)}',
  'table{width:100%;border-collapse:collapse;font-size:13px}',
  'thead{border-bottom:1px solid var(--border);text-align:left}',
  'th{height:32px;padding:0 12px;font-size:11px;font-weight:510;text-transform:uppercase;letter-spacing:0.04em;color:var(--faint)}',
  'td{height:36px;padding:0 12px;vertical-align:middle;font-variant-numeric:tabular-nums}',
  'tbody tr{border-bottom:1px solid var(--border)}',
  'tbody tr:last-child{border-bottom:0}',
  'svg{max-width:100%}',
].join('')

const ARTIFACT_HEIGHT_MESSAGE = 'everdict:artifact-height'
const MIN_FRAME_HEIGHT = 160
const MAX_FRAME_HEIGHT = 1600
const DEFAULT_FRAME_HEIGHT = 480

// The frame reports its own content height up to us, so the model never has to guess one: a wrong guess is
// either a band of dead space under the dashboard or an inner scrollbar, and both read as cheap. Body height is
// content-driven (never the viewport's), so growing the iframe cannot feed back into a new measurement.
const FRAME_SCRIPT = [
  '(function(){var last=0;var send=function(){',
  'var h=Math.ceil(document.body.scrollHeight);if(Math.abs(h-last)<2)return;last=h;',
  `parent.postMessage({type:'${ARTIFACT_HEIGHT_MESSAGE}',height:h},'*')};`,
  'if(window.ResizeObserver)new ResizeObserver(send).observe(document.body);',
  "window.addEventListener('load',send);send()})()",
].join('')

function clampFrameHeight(value: number): number {
  return Math.min(Math.max(Math.ceil(value), MIN_FRAME_HEIGHT), MAX_FRAME_HEIGHT)
}

interface FrameTheme {
  tokens: string
  fontFamily: string
  colorScheme: 'dark' | 'light'
}

function readFrameTheme(): FrameTheme {
  const root = document.documentElement
  const computed = getComputedStyle(root)
  const tokens = FRAME_TOKENS.map((name) => {
    const value = computed.getPropertyValue(name).trim()
    return value ? `${name}:${value}` : ''
  })
    .filter(Boolean)
    .join(';')
  // The app's font stack forwarded verbatim. CSP blocks the webfont fetch inside an opaque origin, so the frame
  // lands on the same system fallback the stack already names — with the app's size and tracking applied.
  return {
    tokens,
    fontFamily: getComputedStyle(document.body).fontFamily,
    colorScheme: root.classList.contains('dark') ? 'dark' : 'light',
  }
}

// The theme cannot be read across an opaque origin, so it is baked into `srcDoc` and re-baked when the member
// toggles it (`html.dark` + localStorage — no next-themes). Identical reads keep the same object so an
// unrelated class change on <html> never reloads the frame.
function useFrameTheme(): FrameTheme | null {
  const [theme, setTheme] = useState<FrameTheme | null>(null)
  useEffect(() => {
    const sync = () =>
      setTheme((previous) => {
        const next = readFrameTheme()
        return previous &&
          previous.tokens === next.tokens &&
          previous.fontFamily === next.fontFamily &&
          previous.colorScheme === next.colorScheme
          ? previous
          : next
      })
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

function HtmlView({ spec, title }: { spec: HtmlSpec; title: string }) {
  const theme = useFrameTheme()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [measured, setMeasured] = useState<number | null>(null)

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only this frame's own report is trusted — the sandbox is opaque-origin, so identity is the source
      // window, not the origin string.
      if (event.source !== frameRef.current?.contentWindow) return
      if (typeof event.data !== 'object' || event.data === null) return
      const { type, height } = event.data as { type?: unknown; height?: unknown }
      if (type !== ARTIFACT_HEIGHT_MESSAGE) return
      if (typeof height !== 'number' || !Number.isFinite(height)) return
      setMeasured(clampFrameHeight(height))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const height = measured ?? clampFrameHeight(spec.height ?? DEFAULT_FRAME_HEIGHT)

  // Pre-mount there is no theme to bake in; hold the space rather than flash an unstyled frame.
  if (!theme) return <div style={{ height }} />

  const shell =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:;\">" +
    `<style>:root{color-scheme:${theme.colorScheme};${theme.tokens}}` +
    `body{font-family:${theme.fontFamily}}${FRAME_STYLESHEET}</style>` +
    `</head><body>${spec.html}<script>${FRAME_SCRIPT}</script></body></html>`
  return (
    <iframe
      ref={frameRef}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={shell}
      title={title}
      className="w-full bg-transparent"
      style={{ height }}
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

// ── Structured dashboard ────────────────────────────────────────────────────────────────────────────────
// The agent sends MEANING — labelled numbers, their baselines, which direction is good — and everything below
// is ours. There is no gate here and none is needed: the spec has no vocabulary for a color, a size or a font,
// so an off-theme dashboard is not something to catch, it is something that cannot be expressed. Each block
// reuses the renderer its kind already has, which is what keeps a dashboard from becoming a second product.

// ⚠ The two spellings are NOT interchangeable here. `destructive` and `muted` are shadcn colors, so
// `bg-destructive/12` generates a utility; `success` and `faint` come from our own `@theme inline` block and
// the `bg-success/x` shorthand generates NOTHING — a chip written that way renders silently transparent, which
// is how a variant ends up looking like bare text next to a proper pill. For those, use the arbitrary form the
// app already uses (`shared/ui/badge.tsx`). Success is tinted a step heavier than destructive because the green
// is the lower-chroma hue, so equal alphas would not carry equal weight.
const SENTIMENT_CLASS: Record<DeltaSentiment, string> = {
  good: 'bg-[var(--color-success)]/15 text-[var(--color-success)]',
  bad: 'bg-destructive/12 text-destructive',
  neutral: 'bg-muted text-faint',
}

function DeltaChip({ metric }: { metric: DashboardMetric }) {
  const delta = metricDelta(metric, (value) => formatY(value, metric.unit, true))
  if (!delta) return null
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-[510] tabular-nums ${SENTIMENT_CLASS[delta.sentiment]}`}
    >
      <span aria-hidden>{deltaArrow(delta.direction)}</span>
      {delta.magnitude}
    </span>
  )
}

function MetricCard({ metric }: { metric: DashboardMetric }) {
  const t = useTranslations('analysisArtifacts')
  const format = (value: number) => formatY(value, metric.unit, true)
  const hasComparison = metric.baseline !== undefined || metric.hint !== undefined
  return (
    <StatCard
      label={metric.label}
      value={format(metric.value)}
      hint={
        hasComparison ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {metric.baseline !== undefined && (
              <span className="tabular-nums">
                {t('metricBaseline', { value: format(metric.baseline) })}
              </span>
            )}
            <DeltaChip metric={metric} />
            {metric.hint && <span className="text-faint">{metric.hint}</span>}
          </span>
        ) : undefined
      }
    />
  )
}

// Block headings match the `html` frame's own h3 treatment, so the two artifact kinds read as one family.
function BlockTitle({ children }: { children: string }) {
  return <h4 className="text-[13px] font-[510] text-foreground">{children}</h4>
}

function BlockView({ block, ariaLabel }: { block: DashboardBlock; ariaLabel: string }) {
  let body: React.ReactNode
  if (block.type === 'metrics')
    body = (
      // Container-queried, never viewport-queried: the same dashboard renders in a narrow chat panel and in a
      // full-width View gallery, so the column count must follow the CARD's width — on a wide monitor a
      // viewport breakpoint would cram four columns into the chat rail.
      <div className="@container">
        <div className="grid gap-2 @md:grid-cols-2 @2xl:grid-cols-3">
          {block.metrics.map((metric, i) => (
            <MetricCard key={`${metric.label}-${i}`} metric={metric} />
          ))}
        </div>
      </div>
    )
  else if (block.type === 'chart')
    body = <ChartView spec={block.chart} ariaLabel={block.title ?? ariaLabel} />
  else if (block.type === 'table') body = <TableView spec={block.table} />
  else body = <Markdown content={block.markdown} className="prose-sm" />

  return (
    <section className="space-y-2">
      {block.title && <BlockTitle>{block.title}</BlockTitle>}
      {body}
    </section>
  )
}

function DashboardView({ spec, title }: { spec: DashboardSpec; title: string }) {
  return (
    <div className="space-y-4">
      {spec.blocks.map((block, i) => (
        <BlockView key={i} block={block} ariaLabel={title} />
      ))}
    </div>
  )
}

const KIND_ICON = {
  chart: BarChart3,
  table: Table2,
  report: FileText,
  html: LayoutDashboard,
  dashboard: LayoutGrid,
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
  } else if (artifact.kind === 'dashboard') {
    const spec = dashboardSpecSchema.safeParse(artifact.spec)
    body = spec.success ? (
      <DashboardView spec={spec.data} title={artifact.title} />
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
    // The id a report notification addresses (`?artifact=<id>` → useAnchorHighlight('artifact')) — a scheduled
    // report lands in a gallery of pinned artifacts, so "the report is ready" has to point at the one produced.
    <article
      id={`artifact-${artifact.id}`}
      className="space-y-3 rounded-lg border bg-card p-4 shadow-raise"
    >
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
