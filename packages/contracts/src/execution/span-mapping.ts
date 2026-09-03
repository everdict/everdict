import { z } from "zod";

// ── HOW A SPAN'S ATTRIBUTES BECOME A TRACE EVENT, AND WHERE THE EVIDENCE IS ──────────────────────────
//
// Split out of `trace-source.ts` so that `harness/harness-spec.ts`, which needs only this, stops importing the
// whole trace-source module — that import was the edge closing a cycle
// (`execution/environment` → `harness/harness-spec` → `execution/trace-source` → `execution/environment`) the
// moment an environment declared services. Nothing here reaches back into `execution/`; `trace-source.ts`
// re-exports every name, so no consumer moved.

// A span attribute can hold the value directly, or hold a JSON container the value lives inside. A selector is
// either the attribute KEY (a plain string, wire-compatible with the original attr-key lists) or `{ key, path }`,
// where `path` reaches inside a JSON attr value with a deliberately-simple dot/bracket syntax —
// "final_answer", "steps[2].action" — NOT full JSONPath.
export const EvidenceSelectorSchema = z.object({
  key: z.string(), // the span-attribute key holding the value (or the JSON container of it)
  path: z.string().optional(), // dot/bracket path into the attr value; absent = the whole value
  pick: z.enum(["last", "first"]).optional(), // which span wins when several carry the key (default "last" = final state)
});
export type EvidenceSelector = z.infer<typeof EvidenceSelectorSchema>;

// An evidence slot = ordered selectors; the FIRST selector that yields a value wins (selector-major resolution).
export const EvidenceSlotSchema = z.array(z.union([z.string(), EvidenceSelectorSchema]));
export type EvidenceSlot = z.infer<typeof EvidenceSlotSchema>;

// Custom evidence-slot names must be template-placeholder-safe and must not shadow the structural/fixed placeholders.
export const RESERVED_EVIDENCE_NAMES = new Set([
  "task",
  "rubric",
  "criteria",
  "dom",
  "expected",
  "final_answer",
  "finalAnswer",
  "response",
  "trace",
  "screenshot",
  "verdict_instruction",
]);
const EVIDENCE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// Per-harness span-attribute mapping — the escape hatch for a harness that does NOT emit the OTel GenAI semantic
// conventions the span→TraceEvent normalizer defaults to. Each field lists attribute keys to try FIRST (before the
// built-in GenAI/MLflow defaults) when deriving that TraceEvent field. Applies to the span-based sources (otel/mlflow).
// The evidence slots (finalAnswer/dom/screenshot + the free-form `evidence` record) have NO built-in defaults — they
// extract judge evidence from the trace itself, so a pulled trace can carry the evidence a run-produced snapshot
// would. Custom `evidence` names become judge promptTemplate placeholders ({<name>}) — the judge DECLARES named
// evidence; the harness overlay REALIZES each name from its own trace (docs/architecture/judge-input-contract.md).
export const SpanAttrMappingSchema = z.object({
  model: z.array(z.string()).optional(), // → llm_call.model
  inputTokens: z.array(z.string()).optional(), // → llm_call.cost.inputTokens
  outputTokens: z.array(z.string()).optional(), // → llm_call.cost.outputTokens
  costUsd: z.array(z.string()).optional(), // → llm_call.cost.usd
  toolName: z.array(z.string()).optional(), // → tool_call.name
  toolCallId: z.array(z.string()).optional(), // → tool_call.id
  toolArgs: z.array(z.string()).optional(), // → tool_call.args
  toolResult: z.array(z.string()).optional(), // → tool_result.output
  messageText: z.array(z.string()).optional(), // → message.text
  finalAnswer: EvidenceSlotSchema.optional(), // → evidence.finalAnswer (+ appended as the trace's final assistant message)
  dom: EvidenceSlotSchema.optional(), // → evidence.dom (the final DOM a browser judge reads; URL values auto-fetch)
  screenshot: EvidenceSlotSchema.optional(), // → evidence.screenshot* (data-URI/base64 inline, else a fetchable ref)
  // Custom named evidence slots → evidence.custom.<name> → the judge's {<name>} placeholder (URL values auto-fetch).
  evidence: z
    .record(
      z
        .string()
        .regex(EVIDENCE_NAME_RE, "evidence slot names must be template-placeholder-safe identifiers")
        .refine((name) => !RESERVED_EVIDENCE_NAMES.has(name), {
          message: "evidence slot name shadows a built-in placeholder",
        }),
      EvidenceSlotSchema,
    )
    .optional(),
});
export type SpanAttrMapping = z.infer<typeof SpanAttrMappingSchema>;
