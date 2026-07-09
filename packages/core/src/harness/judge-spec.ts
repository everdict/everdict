import { z } from "zod";

// Agent Judge — a registrable first-class entity (ownership/version/lifecycle follow the same pattern as harnesses/datasets).
// Two forms: model (a function that calls an LLM/VLM directly) | harness (delegate the verdict to a registered harness agent).
// Execution is done by the control plane over a trace (next increment) — this contract only declares "what renders the verdict".

// Verdict input modality — what the verdict is based on (trace=execution record, dom/screenshot=browser result → VLM).
export const JudgeInputSchema = z.enum(["trace", "dom", "screenshot"]);
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

// model judge: calls an LLM/VLM directly. Renders a verdict from the rubric (criteria) + input modality → {pass, score, reason}.
export const ModelJudgeSpecSchema = z.object({
  kind: z.literal("model"),
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  model: z.string(), // e.g. "claude-opus-4-8"
  rubric: z.string(), // the verdict criteria (prompt)
  inputs: z.array(JudgeInputSchema).default(["trace"]),
  passThreshold: z.number().min(0).max(1).optional(), // score→pass threshold (if absent, the model decides pass directly)
  tags: z.array(z.string()).default([]),
});
export type ModelJudgeSpec = z.infer<typeof ModelJudgeSpecSchema>;

// harness judge: delegates the verdict to a registered harness (agent). version is resolved at run time (latest allowed).
export const HarnessJudgeSpecSchema = z.object({
  kind: z.literal("harness"),
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  harness: z.object({ id: z.string(), version: z.string() }),
  rubric: z.string().optional(),
  // Tenant Runtime id to launch the judge agent on (routed via placement.target). If absent, co-locate with the produced run
  // (inherit the placement of the run that created the observation). An unregistered runtime drops the dispatch to a visible skip.
  runtime: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type HarnessJudgeSpec = z.infer<typeof HarnessJudgeSpecSchema>;

export const JudgeSpecSchema = z.discriminatedUnion("kind", [ModelJudgeSpecSchema, HarnessJudgeSpecSchema]);
export type JudgeSpec = z.infer<typeof JudgeSpecSchema>;
