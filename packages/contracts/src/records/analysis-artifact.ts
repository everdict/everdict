import { z } from "zod";

// Analysis artifacts — durable, declarative outputs the Everdict agent emits during an analysis conversation
// (docs/architecture/analysis-studio.md V2). NEVER active content: a chart is a closed spec our own SVG
// components render, a table is rows, a report is markdown — nothing an LLM emits is executed or injected
// into the DOM. Artifacts live on the conversation (sessionId) and can later be pinned to a View (viewId,
// Studio V3) or produced by a scheduled report (V4).

// Closed chart DSL (v1: line | bar). Point/series caps keep a hallucinating model from flooding the store;
// the emission tool validates BEFORE persisting, so a stored spec is always renderable.
export const ChartSpecSchema = z.object({
  type: z.enum(["line", "bar"]),
  x: z.array(z.string().max(120)).max(500).describe("x-axis labels (buckets/categories)"),
  series: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        points: z.array(z.number().nullable()).max(500).describe("one value per x label (null = no data)"),
      }),
    )
    .min(1)
    .max(12),
  yUnit: z.enum(["ratio", "usd", "seconds", "count", "raw"]).optional().describe("display unit for the y axis"),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;

export const TableSpecSchema = z.object({
  columns: z.array(z.string().max(120)).min(1).max(16),
  rows: z.array(z.array(z.union([z.string().max(500), z.number(), z.null()]))).max(200),
});
export type TableSpec = z.infer<typeof TableSpecSchema>;

export const ReportSpecSchema = z.object({
  markdown: z.string().min(1).max(65_536).describe("the report body (rendered as markdown, never HTML)"),
});
export type ReportSpec = z.infer<typeof ReportSpecSchema>;

// Free-form rich visualization (the Claude-Artifacts model): the agent authors body markup — metric cards,
// baseline/delta chips, inline-SVG/canvas charts, inline <style>/<script> — and the web executes it ONLY inside
// an opaque-origin sandboxed iframe under a deny-all CSP (no network, no parent DOM, no cookies). The safety
// principle stays intact in refined form: LLM output never runs in the APP origin.
export const HtmlSpecSchema = z.object({
  html: z
    .string()
    .min(1)
    .max(512_000)
    .describe("body markup (inline <style>/<script> allowed; ALL external resources are blocked by CSP)"),
  height: z.number().int().min(160).max(1600).optional().describe("render height in px (default 480)"),
});
export type HtmlSpec = z.infer<typeof HtmlSpecSchema>;

export const AnalysisArtifactKindSchema = z.enum(["chart", "table", "report", "html"]);
export type AnalysisArtifactKind = z.infer<typeof AnalysisArtifactKindSchema>;

// The record keeps `spec` opaque (jsonb, like View.config) — the emission boundary validates it per kind via
// parseAnalysisArtifactSpec, so persisted specs are always valid for their kind.
export const AnalysisArtifactRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  kind: AnalysisArtifactKindSchema,
  title: z.string().min(1).max(200),
  sessionId: z.string(), // the conversation that produced it
  viewId: z.string().optional(), // the View it is attached to (Studio V3 pin / V4 report archive)
  pinned: z.boolean().default(false), // pinned to the view's gallery (vs merely produced in a conversation)
  spec: z.unknown(), // ChartSpec | TableSpec | ReportSpec — validated per kind at the emission boundary
  createdBy: z.string(), // subject of the conversation owner / report schedule creator
  createdAt: z.string(),
});
export type AnalysisArtifactRecord = z.infer<typeof AnalysisArtifactRecordSchema>;

const SPEC_SCHEMAS = {
  chart: ChartSpecSchema,
  table: TableSpecSchema,
  report: ReportSpecSchema,
  html: HtmlSpecSchema,
} as const;

// Validate a spec for its kind (throws ZodError) — the single gate every emission path goes through.
export function parseAnalysisArtifactSpec(
  kind: AnalysisArtifactKind,
  spec: unknown,
): ChartSpec | TableSpec | ReportSpec | HtmlSpec {
  return SPEC_SCHEMAS[kind].parse(spec);
}
