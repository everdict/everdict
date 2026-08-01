import type { ToolDefinition, ToolResult } from "@everdict/agent-runtime";
import type { AnalysisArtifactStore } from "@everdict/application-control";
import {
  ARTIFACT_FRAME_CLASSES,
  ARTIFACT_FRAME_TOKENS,
  type AnalysisArtifactKind,
  type AnalysisArtifactRecord,
  ChartSpecSchema,
  DashboardSpecSchema,
  HtmlSpecSchema,
  ReportSpecSchema,
  TableSpecSchema,
  parseAnalysisArtifactSpec,
} from "@everdict/contracts";
import { z } from "zod";

// Artifact emission tools (docs/architecture/analysis-studio.md V2) — the agent turns computed analysis into
// durable, declarative outputs (chart/table/report) instead of ephemeral chat text. Each tool validates the
// spec (a bad spec is a tool error the model can correct), persists the record on the conversation, and
// notifies the host (SSE `artifact` → the web renders it live). Marked read-only: emission only writes
// conversation-scoped presentation state in OUR store (the write_todos precedent) — no external effect, so no
// HITL gate.

export interface ArtifactToolContext {
  artifacts: AnalysisArtifactStore;
  tenant: string;
  sessionId: string;
  createdBy: string;
  now: () => string;
  newId: () => string;
  onArtifact?: (record: AnalysisArtifactRecord) => void;
}

const RenderChartInput = z.object({
  title: z.string().min(1).max(200),
  spec: ChartSpecSchema,
});

const RenderTableInput = z.object({
  title: z.string().min(1).max(200),
  ...TableSpecSchema.shape,
});

const WriteReportInput = z.object({
  title: z.string().min(1).max(200),
  ...ReportSpecSchema.shape,
});

const RenderHtmlInput = z.object({
  title: z.string().min(1).max(200),
  ...HtmlSpecSchema.shape,
});

const RenderDashboardInput = z.object({
  title: z.string().min(1).max(200),
  ...DashboardSpecSchema.shape,
});

const TITLE_PROPERTY = { type: "string", minLength: 1, maxLength: 200, description: "Short human title" };

// The chart and table shapes are declared once and reused by their own tool AND by a dashboard block, so the
// model is never shown two different spellings of the same thing.
const CHART_SPEC_PROPERTY = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["line", "bar"] },
    x: { type: "array", items: { type: "string" }, description: "x-axis labels (buckets/categories)" },
    series: {
      type: "array",
      description: "≤12 series; each carries one numeric point (or null) per x label",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          points: { type: "array", items: { type: ["number", "null"] } },
        },
        required: ["label", "points"],
      },
    },
    yUnit: {
      type: "string",
      enum: ["ratio", "usd", "seconds", "count", "raw"],
      description: "display unit for the y axis",
    },
  },
  required: ["type", "x", "series"],
};

const TABLE_COLUMNS_PROPERTY = { type: "array", items: { type: "string" }, description: "header labels (≤16)" };
const TABLE_ROWS_PROPERTY = {
  type: "array",
  items: { type: "array", items: { type: ["string", "number", "null"] } },
  description: "one array of cell values per row, aligned with columns (≤200 rows)",
};

const METRIC_PROPERTY = {
  type: "object",
  properties: {
    label: { type: "string", description: "what the number measures, e.g. 'Pass rate'" },
    value: { type: "number", description: "the current value (ratio = a 0..1 fraction, not 0..100)" },
    unit: {
      type: "string",
      enum: ["ratio", "usd", "seconds", "count", "raw"],
      description: "how to format it — ratio renders as a percentage",
    },
    baseline: {
      type: "number",
      description: "the comparison value. Send THIS, never a delta — the card subtracts, formats and colors it",
    },
    higherIsBetter: {
      type: "boolean",
      description: "default true. Set FALSE for cost, latency and error counts so a rise reads as a regression",
    },
    hint: { type: "string", description: "one short qualifier, e.g. 'n=300'" },
  },
  required: ["label", "value"],
};

// The render_dashboard brief. This tool exists so that presentation is not something the model has to get
// right: it sends meaning, the product draws it. Everything the model would otherwise decide badly — rounding,
// the sign and color of a change, spacing, dark/light — is decided once, by us, for every dashboard.
const DASHBOARD_BRIEF = [
  "You supply MEANING, the product supplies the design: labelled numbers, their baselines and which direction",
  "is good. It is drawn with the app's own components, so it is on-theme, consistently rounded and readable in",
  "both light and dark by construction — there is no styling for you to author and none to get wrong.",
  "Blocks stack top to bottom: metrics (cards with a big number and an automatic change chip) · chart (line |",
  "bar) · table · note (a short markdown remark). Lead with a metrics block; keep prose to one closing note.",
  "Two things carry most of the quality: send `baseline` and NEVER a delta you computed yourself, and set",
  "higherIsBetter:false on cost, latency and error metrics — otherwise a rising cost is colored as good news.",
].join(" ");

// The render_html brief. The frame hands the model the product's design system (tokens + a class vocabulary,
// see the web's ArtifactCard) precisely so it never has to invent one — an invented palette cannot follow the
// member's light/dark theme and reads as a foreign widget. Stating the vocabulary here, from the SAME contract
// constants the emission schema validates against, is what turns that from a hope into an instruction.
const HTML_FRAME_BRIEF = [
  "THE FRAME SUPPLIES THE DESIGN — you supply structure and numbers. It applies the app's font, type scale and",
  "letter-spacing, and measures your content to size itself (never pad a height for spacing). It publishes the",
  `workspace's LIVE theme tokens: ${ARTIFACT_FRAME_TOKENS.join(" ")}.`,
  `Compose with its classes: ${ARTIFACT_FRAME_CLASSES.join(" · ")}.`,
  'Example: <div class="grid"><div class="metric"><span class="metric-label">Pass rate</span>',
  '<span class="metric-value">62.4%</span><span class="delta up">▲ 4.2pt</span></div></div>.',
  "NEVER author a palette or type of your own: hex/rgb/hsl literals, named colors, gradients, font-family and",
  "emoji are REJECTED by the emission gate. Reach for var(--chart-1..5) for series, var(--success) /",
  "var(--destructive) / var(--warning) for state, var(--foreground) / var(--muted-foreground) / var(--faint)",
  "for text, var(--border) for rules.",
].join(" ");

export function buildArtifactTools(ctx: ArtifactToolContext): ToolDefinition[] {
  const emit = async (kind: AnalysisArtifactKind, title: string, spec: unknown): Promise<ToolResult> => {
    const record: AnalysisArtifactRecord = {
      id: ctx.newId(),
      tenant: ctx.tenant,
      kind,
      title,
      sessionId: ctx.sessionId,
      pinned: false,
      spec: parseAnalysisArtifactSpec(kind, spec),
      createdBy: ctx.createdBy,
      createdAt: ctx.now(),
    };
    await ctx.artifacts.create(record);
    ctx.onArtifact?.(record);
    return {
      content: `Artifact created: ${kind} "${title}" (id: ${record.id}). The user sees it rendered in the conversation — do not repeat its contents in text; refer to it briefly instead.`,
      isError: false,
    };
  };

  return [
    {
      name: "render_dashboard",
      description: [
        "Render a structured analysis dashboard — the PREFERRED way to present numbers, and the right default",
        "for any finished analysis or scheduled report. Compute the real numbers FIRST (query_scorecards /",
        "diff_scorecards) — never invent values.",
        DASHBOARD_BRIEF,
        "Reach for render_html only when a layout genuinely cannot be expressed as these blocks.",
      ].join(" "),
      parametersJsonSchema: {
        type: "object",
        properties: {
          title: TITLE_PROPERTY,
          blocks: {
            type: "array",
            description: "the dashboard top to bottom (≤12 blocks); each block's shape follows its `type`",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["metrics", "chart", "table", "note"] },
                title: { type: "string", description: "optional block heading" },
                metrics: { type: "array", description: "type=metrics: ≤8 cards", items: METRIC_PROPERTY },
                chart: { ...CHART_SPEC_PROPERTY, description: "type=chart: the plot" },
                table: {
                  type: "object",
                  description: "type=table: the rows",
                  properties: { columns: TABLE_COLUMNS_PROPERTY, rows: TABLE_ROWS_PROPERTY },
                  required: ["columns", "rows"],
                },
                markdown: { type: "string", description: "type=note: a short markdown remark" },
              },
              required: ["type"],
            },
          },
        },
        required: ["title", "blocks"],
      },
      inputSchema: RenderDashboardInput,
      isReadOnly: true,
      call: async (input) => {
        const { title, blocks } = RenderDashboardInput.parse(input);
        return emit("dashboard", title, { blocks });
      },
    },
    {
      name: "render_chart",
      description:
        "Render a STANDALONE chart artifact (line | bar) from data you computed (e.g. via query_scorecards). " +
        "x = axis labels, series = one entry per line/bar group with one numeric point per x label (null = no " +
        "data). Use AFTER computing real numbers — never invent values. For a chart that belongs alongside " +
        "metrics or a table, use a render_dashboard chart block instead of emitting several loose artifacts.",
      parametersJsonSchema: {
        type: "object",
        properties: { title: TITLE_PROPERTY, spec: CHART_SPEC_PROPERTY },
        required: ["title", "spec"],
      },
      inputSchema: RenderChartInput,
      isReadOnly: true,
      call: async (input) => {
        const { title, spec } = RenderChartInput.parse(input);
        return emit("chart", title, spec);
      },
    },
    {
      name: "render_table",
      description:
        "Render a table artifact from data you computed. columns = header labels (≤16), rows = cell values " +
        "(string | number | null, ≤200 rows). Prefer a table over pasting rows as chat text.",
      parametersJsonSchema: {
        type: "object",
        properties: { title: TITLE_PROPERTY, columns: TABLE_COLUMNS_PROPERTY, rows: TABLE_ROWS_PROPERTY },
        required: ["title", "columns", "rows"],
      },
      inputSchema: RenderTableInput,
      isReadOnly: true,
      call: async (input) => {
        const { title, columns, rows } = RenderTableInput.parse(input);
        return emit("table", title, { columns, rows });
      },
    },
    {
      name: "render_html",
      description: [
        "ESCAPE HATCH — render a custom visualization as sandboxed HTML. Try render_dashboard FIRST: it covers",
        "metric cards, charts, tables and notes, and the product draws them for you. Come here only for a layout",
        "those blocks genuinely cannot express (a matrix, a bespoke diagram, a novel arrangement).",
        "Author BODY markup with inline <style> and (if needed) inline <script>; ALL external resources and",
        "network calls are blocked (strict CSP, opaque sandbox), so everything must be self-contained. Compute",
        "the real numbers FIRST (query_scorecards / diff_scorecards), then lay them out — lead with the numbers,",
        "not prose.",
        HTML_FRAME_BRIEF,
      ].join(" "),
      parametersJsonSchema: {
        type: "object",
        properties: {
          title: TITLE_PROPERTY,
          html: {
            type: "string",
            description:
              "self-contained body markup (inline <style>/<script> OK; no external URLs — they are blocked). " +
              "Colors and type come from the frame's tokens and classes; literals are rejected.",
          },
          height: {
            type: "integer",
            minimum: 160,
            maximum: 1600,
            description: "optional initial height px; the frame measures your content and takes over from there",
          },
        },
        required: ["title", "html"],
      },
      inputSchema: RenderHtmlInput,
      isReadOnly: true,
      call: async (input) => {
        const { title, html, height } = RenderHtmlInput.parse(input);
        return emit("html", title, { html, ...(height !== undefined ? { height } : {}) });
      },
    },
    {
      name: "write_report",
      description:
        "Write a markdown report artifact — the durable summary of an analysis (findings, evidence, deltas, " +
        "recommendations). Use for a finished analysis or a scheduled report; keep chat text as brief commentary.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          title: TITLE_PROPERTY,
          markdown: { type: "string", description: "the report body (rendered as markdown, never HTML)" },
        },
        required: ["title", "markdown"],
      },
      inputSchema: WriteReportInput,
      isReadOnly: true,
      call: async (input) => {
        const { title, markdown } = WriteReportInput.parse(input);
        return emit("report", title, { markdown });
      },
    },
  ];
}
