import { z } from "zod";
import { VersionSchema } from "../version.js";

// Rubric — HOW to judge (docs/architecture/eval-domain-model.md S3). This module is the dependency root of the
// judging vocabulary: criteria + the verdict-instruction placeholder live here; judge-spec builds on them.

// One rubric criterion — a multi-criteria judge scores every criterion in ONE model call; each lands as its own
// metric (judge:<judge-id>:<criterion-id>) next to the weighted overall (judge:<judge-id>).
export const JudgeCriterionSchema = z.object({
  id: z.string(), // metric suffix — judge:<judge-id>:<criterion-id>
  description: z.string(), // what to assess
  weight: z.number().positive().default(1), // weighted overall = Σ(w·score)/Σw when the model gives no overall score
  passThreshold: z.number().min(0).max(1).optional(), // per-criterion score→pass (absent: the model decides)
});
export type JudgeCriterion = z.infer<typeof JudgeCriterionSchema>;

// A custom promptTemplate MUST carry this placeholder — it expands to the JSON verdict instruction the parser relies on.
export const VERDICT_INSTRUCTION_PLACEHOLDER = "{verdict_instruction}";

// What evidence a judge NEEDS from a run to render a sound verdict — declared, not coded (multi-tenant). assessEvidence
// checks a run's GradeContext against these, so a user learns BEFORE committing whether a given harness produces them.
// All kinds are satisfiable from the TraceEvent + snapshot: `final_answer`/`tool_call`/`dom`/`screenshot` from the
// classic channels, `artifact`/`span` from the ingest-preserved artifact + structural-span TraceEvent kinds.
export const EvidenceRequirementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("final_answer") }), // an assistant final message must exist
  z.object({ kind: z.literal("tool_call"), name: z.string().optional() }), // ≥1 tool_call (optionally a named one)
  z.object({ kind: z.literal("dom") }), // a browser snapshot with DOM
  z.object({ kind: z.literal("screenshot") }), // a screenshot for VLM judging
  z.object({ kind: z.literal("artifact"), role: z.string().optional() }), // a produced artifact (ingest-generalization channel)
  z.object({ kind: z.literal("span"), name: z.string() }), // a structural span preserved through ingest
]);
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

// Rubric — its own versioned registry entity: freeform text and/or named criteria plus an optional custom prompt
// template. One rubric serves many judges (a judge references it as rubric: {id, version} instead of freezing the
// text into its own version) and many datasets — changing the wording is a new rubric version, not a new judge.
export const RubricSpecSchema = z
  .object({
    id: z.string(),
    version: VersionSchema,
    description: z.string().optional(),
    text: z.string().optional(), // freeform rubric text (the RUBRIC section / {rubric} placeholder)
    criteria: z.array(JudgeCriterionSchema).min(1).optional(), // multi-criteria: one score per criterion + overall
    promptTemplate: z.string().optional(), // full custom judging prompt (must carry {verdict_instruction})
    tags: z.array(z.string()).default([]),
  })
  .superRefine((spec, ctx) => {
    if (!spec.text && !spec.criteria && !spec.promptTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A rubric must carry at least one of text/criteria/promptTemplate.",
      });
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
export type RubricSpec = z.infer<typeof RubricSpecSchema>;

// A judge's rubric field: inline freeform text (back-compat, forever valid) OR a reference to a registered rubric.
export const RubricRefSchema = z.object({ id: z.string(), version: z.string().default("latest") });
export type RubricRef = z.infer<typeof RubricRefSchema>;
