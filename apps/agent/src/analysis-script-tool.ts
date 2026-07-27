import type { ToolDefinition } from "@everdict/agent-runtime";
import { z } from "zod";
import { type CodeToolRuntime, buildCodeTool } from "./code-tools.js";

// run_analysis (docs/architecture/analysis-studio.md V5) — the data-scientist escape hatch: the model writes a
// short script (stats/custom transforms beyond the canned pivots) and it executes through the SAME dispatched
// script contract code tools use. Two hard gates, defense in depth: (1) model-authored code NEVER runs outside
// an ISOLATED runtime — a non-isolated (dev/self-hosted LocalDriver) host gets no tool at all (the adopted-code
// precedent); (2) isReadOnly:false → every call is HITL/permission-mode gated. Off by default — the operator
// opts in with AGENT_ALLOW_RUN_ANALYSIS=true (main.ts).

const RunAnalysisInput = z.object({
  language: z.enum(["python", "node"]),
  code: z.string().min(1).max(65_536),
  input: z.unknown().optional(),
});

const TIMEOUT_SEC = 60;

export function buildRunAnalysisTool(runtime: CodeToolRuntime): ToolDefinition | undefined {
  if (!runtime.isolated) return undefined; // never on a non-isolated host — no tool beats a refusing tool
  return {
    name: "run_analysis",
    description:
      "Run a short data-analysis script (python | node) in an ISOLATED sandbox — for statistics or transforms " +
      "beyond query_scorecards (significance tests, cohort splits, custom bucketing). Pass the data via `input` " +
      "(the script reads it as JSON from the path in argv[1]); print the result to stdout (a final " +
      '{"content": "..."} JSON is honored). No network guarantees, no secrets — compute over the input only. ' +
      "Prefer query_scorecards / render_chart when they suffice.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "node"] },
        code: {
          type: "string",
          description: "the whole script — reads the JSON input file at argv[1], prints results to stdout",
        },
        input: { description: "JSON data the script analyzes (e.g. a query_scorecards result)" },
      },
      required: ["language", "code"],
    },
    inputSchema: RunAnalysisInput,
    isReadOnly: false, // every call is HITL/permission-mode gated
    call: async (input, ctx) => {
      const { language, code, input: scriptInput } = RunAnalysisInput.parse(input);
      // Reuse the code-tool execution contract verbatim (provision → write input+script → interpreter → stdout),
      // with the model's code as the pinned source for this one call. sandbox:true re-asserts isolation.
      const inner = buildCodeTool(
        {
          name: "run_analysis",
          description: "ad-hoc analysis script",
          language,
          code,
          parametersSchema: {},
          isReadOnly: false,
          env: {}, // deliberately empty — model code gets no secrets
          timeoutSec: TIMEOUT_SEC,
          sandbox: true,
        },
        runtime,
      );
      return inner.call(scriptInput ?? {}, ctx);
    },
  };
}
