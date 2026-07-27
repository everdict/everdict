import type { ToolDefinition } from "@everdict/agent-runtime";
import { z } from "zod";

// apply_view_config (docs/architecture/analysis-studio.md V3) — the agent drives the SAME pivot canvas the
// pickers drive: it hands the host a stored-form analysis config (the exact flat vocabulary a saved View's
// `config` uses, so what get_view returns can be edited and applied verbatim), the host streams it to the web
// (SSE `view_config`), and the analyze canvas applies it live. Presentation-only and fully reversible (the
// member can keep hand-tuning), so no HITL gate. Only registered when the host wires the hook (a live web
// chat) — headless report/teammate turns never get it.

const ApplyViewConfigInput = z.object({
  group: z.string().optional().describe("row dimensions, comma-separated (0..2) — e.g. 'harness' or 'day,harness'"),
  pivot: z.string().optional().describe("column dimension"),
  metric: z.string().optional().describe("summary metric name"),
  measure: z.enum(["passRate", "mean", "count", "latest"]).optional(),
  viz: z.enum(["table", "bars", "line"]).optional(),
  sort: z.string().optional().describe("'measure:desc' | 'measure:asc' | 'label:asc' | 'label:desc'"),
  q: z.string().optional().describe("free-text search filter"),
  dataset: z.string().optional().describe("dataset id filter, comma-separated"),
  harness: z.string().optional().describe("harness id filter, comma-separated"),
  model: z.string().optional().describe("model filter, comma-separated"),
  judgeModel: z.string().optional().describe("judge model filter, comma-separated"),
  status: z.string().optional().describe("status filter, comma-separated"),
  owner: z.string().optional().describe("owner subject filter, comma-separated"),
  origin: z.string().optional().describe("origin source filter, comma-separated"),
  from: z.string().optional().describe("createdAt >= (ISO date, e.g. 2026-07-01)"),
  to: z.string().optional().describe("createdAt <= (ISO date, inclusive)"),
  incomplete: z.enum(["1"]).optional().describe("'1' to include queued/running/superseded/cancelled"),
});
export type ApplyViewConfigInputShape = z.infer<typeof ApplyViewConfigInput>;

const STRING_PROP = { type: "string" };

export function buildViewConfigTool(onViewConfig: (config: Record<string, string>) => void): ToolDefinition {
  return {
    name: "apply_view_config",
    description:
      "Change what the user's analysis canvas (the analyze dashboard / open View) shows — group/pivot/measure/" +
      "metric/viz/filters, the SAME flat vocabulary a saved View's config uses (what get_view returns can be " +
      "tweaked and re-applied). Use it to SHOW an analysis instead of describing one: e.g. viz 'line' + group " +
      "'day,harness' + measure 'passRate' renders the pass-rate trend per harness. Unset keys reset to defaults. " +
      "The user keeps full manual control afterwards.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "row dimensions, comma-separated (0..2), e.g. 'day,harness'" },
        pivot: STRING_PROP,
        metric: STRING_PROP,
        measure: { type: "string", enum: ["passRate", "mean", "count", "latest"] },
        viz: { type: "string", enum: ["table", "bars", "line"] },
        sort: { type: "string", description: "'measure:desc' | 'measure:asc' | 'label:asc' | 'label:desc'" },
        q: STRING_PROP,
        dataset: STRING_PROP,
        harness: STRING_PROP,
        model: STRING_PROP,
        judgeModel: STRING_PROP,
        status: STRING_PROP,
        owner: STRING_PROP,
        origin: STRING_PROP,
        from: STRING_PROP,
        to: STRING_PROP,
        incomplete: { type: "string", enum: ["1"] },
      },
    },
    inputSchema: ApplyViewConfigInput,
    isReadOnly: true,
    call: async (input) => {
      const parsed = ApplyViewConfigInput.parse(input);
      const config: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") config[key] = value;
      onViewConfig(config);
      return {
        content:
          "Applied — the user's analysis canvas now shows this configuration. Refer to what it shows; do not re-describe it in full.",
        isError: false,
      };
    },
  };
}
