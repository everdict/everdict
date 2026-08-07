import { z } from "zod";

// Release-gate decision artifact (metrics commercialization A1/B1) — the CI-facing verdict over a
// baseline↔candidate comparison, RECORDED so governance can count what it never saw happen live: every
// decision, every block, every override with its reason (catalog R7). The gate stands on the trust kernel's
// comparability semantics: `not_comparable` is a FIRST-CLASS decision — "the comparison does not hold" is a
// different claim from "no differences", and a gate that answers pass on an incomparable pair is a false
// green light.
export const GatePolicySchema = z.object({
  // How many (statistically-gated, when trials rode along) regressions the gate tolerates. 0 = any regression
  // blocks. The effective policy is embedded in every decision — a decision must be re-derivable without the
  // caller's flags.
  maxRegressions: z.number().int().nonnegative(),
});
export type GatePolicy = z.infer<typeof GatePolicySchema>;

export const GateReasonSchema = z.object({
  kind: z.enum(["regression", "trial_regression", "policy_mismatch", "no_shared_cases", "kind_changed"]),
  detail: z.string(),
  caseId: z.string().optional(),
  metric: z.string().optional(),
});
export type GateReason = z.infer<typeof GateReasonSchema>;

export const GateOverrideSchema = z.object({
  by: z.string(),
  reason: z.string().min(1), // a forced ship without a stated reason is not an override, it is an accident
  at: z.string(),
});
export type GateOverride = z.infer<typeof GateOverrideSchema>;

export const GateDecisionSchema = z.object({
  id: z.string(),
  baseline: z.string(), // scorecard id
  candidate: z.string(), // scorecard id (the record this decision is appended to)
  decision: z.enum(["pass", "block", "not_comparable"]),
  reasons: z.array(GateReasonSchema),
  policy: GatePolicySchema, // embedded in full — re-derivable without the caller
  policyDigest: z.string(),
  // The comparison evidence the decision stands on (counts, never the full diff — that is re-derivable).
  evidence: z.object({
    comparability: z.enum(["full", "partial", "none"]),
    regressions: z.number().int().nonnegative(),
    improvements: z.number().int().nonnegative(),
    missingCases: z.number().int().nonnegative(),
    trialsGated: z.boolean(), // true = the regression count is the Fisher-gated trials diff, not raw transitions
  }),
  decidedBy: z.string().optional(),
  decidedAt: z.string(),
  // B1 — the recorded force: a block that shipped anyway, with who and why (audit reads these).
  override: GateOverrideSchema.optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;
