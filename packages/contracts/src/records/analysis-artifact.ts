import { z } from "zod";

// Analysis artifacts — durable, declarative outputs the Everdict agent emits during an analysis conversation
// (docs/architecture/analysis-studio.md V2). Never active content IN THE APP: a chart is a closed spec our own
// SVG components render, a table is rows, a report is markdown, and the one free-form kind (`html`) runs only
// in an opaque-origin sandbox — nothing an LLM emits is injected into the app's own DOM. Artifacts live on the
// conversation (sessionId) and can later be pinned to a View (viewId, Studio V3) or produced by a scheduled
// report (V4).

// One unit vocabulary for the whole artifact family, so a metric card and the chart plotting the same measure
// are formatted identically (a dashboard that says 62.4% over an axis that says 0.62 reads as two products).
export const MetricUnitSchema = z.enum(["ratio", "usd", "seconds", "count", "raw"]);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

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
  yUnit: MetricUnitSchema.optional().describe("display unit for the y axis"),
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

// Structured dashboard — the answer to agent-authored design rather than a defence against it. The model emits
// the MEANING of a dashboard (metrics with their baselines, charts, tables, notes) and our own components draw
// it, so there is nothing to police: this spec cannot name a color, a size, a font or a layout, which is the
// only thing the free-form `html` kind can ever be *prevented* from doing. Blocks compose the kinds we already
// render well, so a dashboard is a LAYOUT over the primitives, not a second rendering system.
export const DashboardMetricSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.number(),
  unit: MetricUnitSchema.optional(),
  // Give the baseline, NOT the delta. We subtract, format and color it — a model doing its own percentage
  // arithmetic gets it wrong often enough to matter, and the answer must round the same way everywhere.
  baseline: z.number().optional().describe("the comparison value; the delta is computed and colored for you"),
  // Whether a RISE is good. Cost and latency rising is bad, pass rate rising is good — without this the chip
  // would be colored by arithmetic instead of by meaning, which is worse than showing no color at all.
  higherIsBetter: z.boolean().optional().describe("does a rise mean better? default true — false for cost/latency"),
  hint: z.string().max(120).optional().describe("one short qualifier, e.g. sample size"),
});
export type DashboardMetric = z.infer<typeof DashboardMetricSchema>;

const BlockTitle = z.string().max(80).optional();

export const DashboardBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("metrics"), title: BlockTitle, metrics: z.array(DashboardMetricSchema).min(1).max(8) }),
  z.object({ type: z.literal("chart"), title: BlockTitle, chart: ChartSpecSchema }),
  z.object({ type: z.literal("table"), title: BlockTitle, table: TableSpecSchema }),
  z.object({ type: z.literal("note"), title: BlockTitle, markdown: z.string().min(1).max(4_000) }),
]);
export type DashboardBlock = z.infer<typeof DashboardBlockSchema>;

export const DashboardSpecSchema = z.object({
  blocks: z.array(DashboardBlockSchema).min(1).max(12),
});
export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;

// Free-form rich visualization (the Claude-Artifacts model): the agent authors body markup — metric cards,
// baseline/delta chips, inline-SVG/canvas charts, inline <style>/<script> — and the web executes it ONLY inside
// an opaque-origin sandboxed iframe under a deny-all CSP (no network, no parent DOM, no cookies). The safety
// principle stays intact in refined form: LLM output never runs in the APP origin.

// The design tokens the artifact frame publishes INTO the sandbox, carrying the live value of whichever theme
// the member is on. Markup composes from these; it never picks a color. (apps/web mirrors this list in
// `entities/analysis-artifact/ui/artifact-card.tsx` — runtime decoupling forbids the web importing a value
// from contracts, so the two lists are kept in step by hand.)
export const ARTIFACT_FRAME_TOKENS = [
  "--foreground",
  "--muted-foreground",
  "--faint",
  "--card",
  "--elevated",
  "--accent",
  "--border",
  "--border-strong",
  "--primary",
  "--link",
  "--success",
  "--warning",
  "--destructive",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-other",
  "--radius",
] as const;

// The class vocabulary the frame's stylesheet defines, so a dashboard is COMPOSED from the product's own parts
// instead of restyled from scratch. Named here because the emission tool's description quotes this list.
export const ARTIFACT_FRAME_CLASSES = [
  "grid",
  "row",
  "panel",
  "metric",
  "metric-label",
  "metric-value",
  "metric-sub",
  "delta up|down|flat",
  "muted",
  "faint",
] as const;

// `url(#gradient-a)` and `href="#defs-1"` are structural inline-SVG references, not colors — neutralize them
// before the hex scan so a legitimate SVG chart is not read as a hardcoded palette.
function withoutFragmentRefs(html: string): string {
  return html
    .replace(/url\(\s*['"]?#[^)]*\)/gi, "url()")
    .replace(/(?:xlink:)?href\s*=\s*(['"])#[^'"]*\1/gi, "href=$1$1");
}

const PAINT_PROPERTY =
  "color|background|background-color|border|border-color|border-top|border-right|border-bottom|border-left|outline|outline-color|fill|stroke|stop-color|box-shadow|text-shadow|accent-color|caret-color";
const NAMED_PAINT =
  "red|green|blue|yellow|orange|purple|violet|indigo|pink|magenta|cyan|teal|lime|gold|crimson|tomato|coral|salmon|turquoise|aqua|fuchsia|navy|maroon|olive|silver|white|black|gray|grey";

const TOKEN_HINT = `use the injected theme tokens instead (${ARTIFACT_FRAME_TOKENS.join(", ")}) — e.g. var(--chart-1), color-mix(in oklab, var(--success) 12%, transparent)`;

// A color can only be AUTHORED in a styling region: a <style> block, a `style=""` attribute, or a paint
// attribute on an element. Scanning the whole document instead mistakes DATA for design — an eval dashboard
// legitimately prints "case #4521", a commit "#a8d39b" or "PR #1234", and bouncing those would order the model
// to recolor text it must not touch (and, in an unattended report turn, to burn its budget doing it). Paint
// attributes are normalized to `name:value` so one property-prefixed rule covers CSS and SVG alike.
// Known limit: a color assigned from inline <script> (`el.style.background = …`) is not a styling region and
// slips through. This is a design guard, not a security boundary — the brief steers to CSS, and the frame's
// stylesheet is what a model reaches for.
function styleRegions(html: string): string {
  const parts: string[] = [];
  for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) parts.push(match[1] ?? "");
  for (const match of html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) parts.push(match[1] ?? match[2] ?? "");
  for (const match of html.matchAll(
    /\s(fill|stroke|stop-color|color|bgcolor|flood-color|lighting-color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  ))
    parts.push(`${match[1]}:${match[2] ?? match[3] ?? ""}`);
  return parts.join(";\n");
}

// `style` = only what the markup paints with; `document` = the whole artifact (content included).
type HtmlStyleScope = "style" | "document";

interface HtmlStyleRule {
  readonly scope: HtmlStyleScope;
  readonly pattern: RegExp;
  readonly message: (found: string) => string;
}

// Design conformance for agent-authored markup. The frame ships the workspace's theme, so inventing a color, a
// font or a gradient is never necessary — and always wrong: a literal cannot follow the member's light/dark
// theme, which is exactly what makes a generated dashboard read as a foreign widget pasted into the product.
// A violation is a ZodError at the emission gate, which the agent loop hands back as a correctable tool error.
const HTML_STYLE_RULES: readonly HtmlStyleRule[] = [
  {
    scope: "style",
    pattern: /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])/i,
    message: (found) => `hardcoded color "${found}": ${TOKEN_HINT}.`,
  },
  {
    scope: "style",
    pattern: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/i,
    message: (found) => `hardcoded color function "${found})": ${TOKEN_HINT}. color-mix() over a token is allowed.`,
  },
  {
    scope: "style",
    pattern: /\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i,
    message: (found) =>
      `gradient "${found})": the product's surfaces are flat — use a token background (var(--elevated), var(--card)) or the .panel class.`,
  },
  {
    scope: "style",
    pattern: /font-family\s*:|@font-face|@import\b/i,
    message: (found) =>
      `"${found}": the frame already applies the app's font, size and letter-spacing — do not set type. External fonts are blocked by CSP anyway.`,
  },
  {
    scope: "style",
    pattern: new RegExp(`(?:${PAINT_PROPERTY})\\s*[:=]\\s*["']?[^;"'{}<>]*\\b(?:${NAMED_PAINT})\\b`, "i"),
    message: (found) => `named color in "${found}": ${TOKEN_HINT}.`,
  },
  {
    scope: "document",
    pattern: /\p{Extended_Pictographic}/u,
    message: (found) =>
      `emoji "${found}": the product uses no emoji — express direction with ▲ ▼ — and state, with a token-colored .delta chip. If it came from the data, strip it from the label.`,
  },
];

const MAX_REPORTED_VIOLATIONS = 4;

/** Design-system violations in agent-authored artifact markup (empty = conformant). */
export function findHtmlStyleViolations(html: string): string[] {
  const scoped: Record<HtmlStyleScope, string> = {
    style: withoutFragmentRefs(styleRegions(html)),
    document: html,
  };
  const violations: string[] = [];
  for (const rule of HTML_STYLE_RULES) {
    const found = scoped[rule.scope].match(rule.pattern);
    if (found) violations.push(rule.message(found[0]));
    if (violations.length === MAX_REPORTED_VIOLATIONS) break;
  }
  return violations;
}

export const HtmlSpecSchema = z.object({
  html: z
    .string()
    .min(1)
    .max(512_000)
    .describe(
      "body markup (inline <style>/<script> allowed; ALL external resources are blocked by CSP). Colors, type " +
        "and radii come from the injected theme tokens — literals are rejected.",
    )
    .superRefine((value, ctx) => {
      for (const message of findHtmlStyleViolations(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }),
  height: z
    .number()
    .int()
    .min(160)
    .max(1600)
    .optional()
    .describe("initial render height in px; the frame measures its content and takes over from there"),
});
export type HtmlSpec = z.infer<typeof HtmlSpecSchema>;

export const AnalysisArtifactKindSchema = z.enum(["chart", "table", "report", "html", "dashboard"]);
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
  dashboard: DashboardSpecSchema,
} as const;

// Validate a spec for its kind (throws ZodError) — the single gate every emission path goes through.
export function parseAnalysisArtifactSpec(
  kind: AnalysisArtifactKind,
  spec: unknown,
): ChartSpec | TableSpec | ReportSpec | HtmlSpec | DashboardSpec {
  return SPEC_SCHEMAS[kind].parse(spec);
}
