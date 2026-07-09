import { z } from "zod";

// Agent Judge — a registrable first-class entity (ownership/version/lifecycle follow the same pattern as harnesses/datasets).
// Two forms: model (a function that calls an LLM/VLM directly) | harness (delegate the verdict to a registered harness agent).
// Execution is done by the control plane over a trace (next increment) — this contract only declares "what renders the verdict".

// Verdict input modality — what the verdict is based on (trace=execution record, dom/screenshot=browser result → VLM).
export const JudgeInputSchema = z.enum(["trace", "dom", "screenshot"]);
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

// One rubric criterion — a multi-criteria judge scores every criterion in ONE model call; each lands as its own
// metric (judge:<judge-id>:<criterion-id>) next to the weighted overall (judge:<judge-id>). docs/architecture/eval-domain-model.md
export const JudgeCriterionSchema = z.object({
  id: z.string(), // metric suffix — judge:<judge-id>:<criterion-id>
  description: z.string(), // what to assess
  weight: z.number().positive().default(1), // weighted overall = Σ(w·score)/Σw when the model gives no overall score
  passThreshold: z.number().min(0).max(1).optional(), // per-criterion score→pass (absent: the model decides)
});
export type JudgeCriterion = z.infer<typeof JudgeCriterionSchema>;

// A custom promptTemplate MUST carry this placeholder — it expands to the JSON verdict instruction the parser relies on.
export const VERDICT_INSTRUCTION_PLACEHOLDER = "{verdict_instruction}";

// Custom-prompt + criteria fields shared by both judge kinds (the prompt-build path is the same; only the transport differs).
const judgePromptFields = {
  // Full custom judging prompt. Placeholders: {task} {rubric} {criteria} {dom} {final_answer} {response} {trace}
  // {verdict_instruction}. Absent → the default template (identical to the previous hardcoded prompt).
  promptTemplate: z.string().optional(),
  criteria: z.array(JudgeCriterionSchema).min(1).optional(), // multi-criteria: one score per criterion + overall
};

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
  passThreshold: z.number().min(0).max(1).optional(), // overall score→pass threshold (if absent, the model decides pass directly)
  ...judgePromptFields,
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
  ...judgePromptFields,
  tags: z.array(z.string()).default([]),
});
export type HarnessJudgeSpec = z.infer<typeof HarnessJudgeSpecSchema>;

// Registration-time template/criteria validation rides the schema itself (every boundary parses through it):
// a template without the verdict instruction would break verdict parsing at grading time — fail at the boundary instead.
export const JudgeSpecSchema = z
  .discriminatedUnion("kind", [ModelJudgeSpecSchema, HarnessJudgeSpecSchema])
  .superRefine((spec, ctx) => {
    if (spec.promptTemplate && !spec.promptTemplate.includes(VERDICT_INSTRUCTION_PLACEHOLDER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["promptTemplate"],
        message: `promptTemplate must include ${VERDICT_INSTRUCTION_PLACEHOLDER} (the JSON verdict instruction the parser relies on).`,
      });
    }
    const ids = (spec.criteria ?? []).map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criteria"],
        message: "criteria ids must be unique (each becomes a metric suffix).",
      });
    }
  });
export type JudgeSpec = z.infer<typeof JudgeSpecSchema>;
