import type {
  AnalysisArtifactRecord,
  AnalysisArtifactKind as WireAnalysisArtifactKind,
  ChartSpec as WireChartSpec,
  HtmlSpec as WireHtmlSpec,
  ReportSpec as WireReportSpec,
  TableSpec as WireTableSpec,
} from '@everdict/contracts'
import { z } from 'zod'

// Analysis artifacts — the durable chart/table/report outputs the Everdict agent emits (analysis-studio V2/V3).
// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4, `import type` only). The record's `spec` is opaque jsonb — render paths validate it per
// kind with the spec schemas below and fall back gracefully on a mismatch (never crash the page on bad data).

export const analysisArtifactKinds = ['chart', 'table', 'report', 'html'] as const
export const analysisArtifactKindSchema = z.enum(analysisArtifactKinds)

export const chartSpecSchema = z.object({
  type: z.enum(['line', 'bar']),
  x: z.array(z.string()),
  series: z.array(z.object({ label: z.string(), points: z.array(z.number().nullable()) })).min(1),
  yUnit: z.enum(['ratio', 'usd', 'seconds', 'count', 'raw']).optional(),
})

export const tableSpecSchema = z.object({
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
})

export const reportSpecSchema = z.object({ markdown: z.string() })

// Sandboxed rich visualization — executed ONLY in an opaque-origin iframe under a deny-all CSP (HtmlView).
export const htmlSpecSchema = z.object({ html: z.string(), height: z.number().optional() })

export const analysisArtifactSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  kind: analysisArtifactKindSchema,
  title: z.string(),
  sessionId: z.string(),
  viewId: z.string().optional(),
  pinned: z.boolean(),
  spec: z.unknown(),
  createdBy: z.string(),
  createdAt: z.string(),
})

export const analysisArtifactsResponseSchema = z.object({
  artifacts: z.array(analysisArtifactSchema),
})

// Drift guards — identical shape both ways (spec stays opaque on both sides, like View.config).
type AssertAssignable<A extends B, B> = A
type WebArtifact = z.infer<typeof analysisArtifactSchema>
type WebKind = z.infer<typeof analysisArtifactKindSchema>
type WebChartSpec = z.infer<typeof chartSpecSchema>
type WebTableSpec = z.infer<typeof tableSpecSchema>
type WebReportSpec = z.infer<typeof reportSpecSchema>
type WebHtmlSpec = z.infer<typeof htmlSpecSchema>
type _artifactFwd = AssertAssignable<
  Omit<WebArtifact, 'spec'>,
  Omit<AnalysisArtifactRecord, 'spec'>
>
type _artifactBack = AssertAssignable<
  Omit<AnalysisArtifactRecord, 'spec'>,
  Omit<WebArtifact, 'spec'>
>
type _kindFwd = AssertAssignable<WebKind, WireAnalysisArtifactKind>
type _kindBack = AssertAssignable<WireAnalysisArtifactKind, WebKind>
type _chartFwd = AssertAssignable<WebChartSpec, WireChartSpec>
type _tableFwd = AssertAssignable<WebTableSpec, WireTableSpec>
type _reportFwd = AssertAssignable<WebReportSpec, WireReportSpec>
type _htmlFwd = AssertAssignable<WebHtmlSpec, WireHtmlSpec>

// Exported names alias the contract types (consumers see the wire shapes).
export type AnalysisArtifact = AnalysisArtifactRecord
export type AnalysisArtifactKind = WireAnalysisArtifactKind
export type ChartSpec = WireChartSpec
export type TableSpec = WireTableSpec
export type ReportSpec = WireReportSpec
export type HtmlSpec = WireHtmlSpec

export type __analysisArtifactDriftGuard = [
  _artifactFwd,
  _artifactBack,
  _kindFwd,
  _kindBack,
  _chartFwd,
  _tableFwd,
  _reportFwd,
  _htmlFwd,
]
