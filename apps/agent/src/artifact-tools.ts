import type { ToolDefinition, ToolResult } from "@everdict/agent-runtime";
import type { AnalysisArtifactStore } from "@everdict/application-control";
import {
  type AnalysisArtifactKind,
  type AnalysisArtifactRecord,
  ChartSpecSchema,
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

const TITLE_PROPERTY = { type: "string", minLength: 1, maxLength: 200, description: "Short human title" };

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
      name: "render_chart",
      description:
        "Render a chart artifact (line | bar) from data you computed (e.g. via query_scorecards). x = axis labels, " +
        "series = one entry per line/bar group with one numeric point per x label (null = no data). Use AFTER " +
        "computing real numbers — never invent values. The chart persists on the conversation and renders live.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          title: TITLE_PROPERTY,
          spec: {
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
          },
        },
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
        properties: {
          title: TITLE_PROPERTY,
          columns: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: { type: "array", items: { type: ["string", "number", "null"] } },
            description: "one array of cell values per row, aligned with columns",
          },
        },
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
