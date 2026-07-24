import { z } from "zod";
import { VersionSchema } from "../version.js";

// Agent Judge — a registrable first-class entity (ownership/version/lifecycle follow the same pattern as harnesses/datasets).
// Two forms: model (a function that calls an LLM/VLM directly) | harness (delegate the verdict to a registered harness agent).
// Execution is done by the control plane over a trace (next increment) — this contract only declares "what renders the verdict".

import { ModelBindingSchema } from "./model-spec.js";
import {
  EvidenceRequirementSchema,
  JudgeCriterionSchema,
  RubricRefSchema,
  VERDICT_INSTRUCTION_PLACEHOLDER,
} from "./rubric-spec.js";

// Verdict input modality — what the verdict is based on (trace=execution record, dom/screenshot=browser result → VLM).
export const JudgeInputSchema = z.enum(["trace", "dom", "screenshot"]);
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

// Custom-prompt + criteria fields shared by both judge kinds (the prompt-build path is the same; only the transport differs).
const judgePromptFields = {
  // Full custom judging prompt. Placeholders: {task} {rubric} {criteria} {dom} {final_answer} {response} {trace}
  // {verdict_instruction}. Absent → the default template (identical to the previous hardcoded prompt).
  promptTemplate: z.string().optional(),
  criteria: z.array(JudgeCriterionSchema).min(1).optional(), // multi-criteria: one score per criterion + overall
  // What this judge NEEDS from a run's evidence — assessEvidence checks it in the preview/dry-run so a user knows
  // (before committing) whether the target harness produces it. Optional; absent → today's coarse `inputs` behavior.
  requires: z.array(EvidenceRequirementSchema).optional(),
};

// model judge: calls an LLM/VLM directly. Renders a verdict from the rubric (criteria) + input modality → {pass, score, reason}.
export const ModelJudgeSpecSchema = z.object({
  kind: z.literal("model"),
  id: z.string(),
  version: VersionSchema,
  description: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"), // fallback provider for a RAW-STRING model; a registered-model ref derives it from the ModelSpec
  // A registered Model reference (id string | {ref, version?, env?}) — the SAME first-class binding a harness uses. A ref
  // resolves the workspace Model's provider/underlying model/baseUrl/apiKeySecret at judge-run time (one definition carries
  // its own connection everywhere); a bare string that is not a registered id stays a raw model name (e.g. "claude-opus-4-8").
  model: ModelBindingSchema,
  rubric: z.union([z.string(), RubricRefSchema]), // inline verdict criteria text OR a registered-rubric reference
  inputs: z.array(JudgeInputSchema).default(["trace"]),
  passThreshold: z.number().min(0).max(1).optional(), // overall score→pass threshold (if absent, the model decides pass directly)
  ...judgePromptFields,
  tags: z.array(z.string()).default([]),
});
export type ModelJudgeSpec = z.infer<typeof ModelJudgeSpecSchema>;

// code judge — THE main judge tier: user Python/Node code renders the verdict from the full judge context
// ({case, trace, snapshot, evidence} — argv[1] = the serialized context path; print a Score[] JSON as the LAST
// thing on stdout, metric "judge" for the overall → rewritten to judge:<id>). Runs SANDBOXED via dispatch (never
// on the control plane): the runner wraps it in a no-op command-harness job whose script grader executes the code.
// `model` rides the job.judge channel — the code reads EVERDICT_JUDGE_MODEL/EVERDICT_JUDGE_PROVIDER plus the
// provider key env (ANTHROPIC_API_KEY / OPENAI_API_KEY [+_BASE_URL]) that JudgeAuthDispatcher resolves/injects.
// model/harness judges remain ENGINE-INTERNAL for already-registered specs; new registration surfaces expose code only.
export const CodeJudgeSpecSchema = z.object({
  kind: z.literal("code"),
  id: z.string(),
  version: VersionSchema,
  description: z.string().optional(),
  language: z.enum(["python", "node"]),
  code: z.string().optional(), // inline source — frozen into this judge version
  entrypoint: z.string().optional(), // OR a script path inside `image` (a baked judge image)
  image: z.string().optional(), // dedicated judge image (must be everdict-baked); absent = the default job-runner image
  model: ModelBindingSchema.optional(), // the model the code may call — registered Model ref | raw model string
  provider: z.enum(["anthropic", "openai"]).optional(), // fallback provider for a RAW-STRING model
  timeoutSec: z.number().int().positive().default(600),
  // Tenant Runtime id to run the judge code on (routed via placement.target). Absent = co-locate with the produced run.
  runtime: z.string().optional(),
  requires: z.array(EvidenceRequirementSchema).optional(), // declared evidence needs — the preview checks them
  tags: z.array(z.string()).default([]),
});
export type CodeJudgeSpec = z.infer<typeof CodeJudgeSpecSchema>;

// harness judge: delegates the verdict to a registered harness (agent). version is resolved at run time (latest allowed).
export const HarnessJudgeSpecSchema = z.object({
  kind: z.literal("harness"),
  id: z.string(),
  version: VersionSchema,
  description: z.string().optional(),
  harness: z.object({ id: z.string(), version: z.string() }),
  rubric: z.union([z.string(), RubricRefSchema]).optional(), // inline text OR a registered-rubric reference
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
  .discriminatedUnion("kind", [ModelJudgeSpecSchema, HarnessJudgeSpecSchema, CodeJudgeSpecSchema])
  .superRefine((spec, ctx) => {
    if (spec.kind === "code") {
      if (!spec.code && !spec.entrypoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["code"],
          message: "A code judge requires `code` (inline source) or `entrypoint` (a script path in its image).",
        });
      }
      return;
    }
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
