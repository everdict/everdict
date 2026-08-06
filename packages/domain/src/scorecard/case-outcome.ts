import type { CaseFailure, CaseResult, Scorecard } from "@everdict/contracts";
import { PRE_OUTCOME_STAGES, caseVerdict } from "./scorecard.js";

// Case outcome — the case's fate as a first-class value, so "the agent failed the task" and "the platform
// failed the case" can never share a denominator. A result carrying a PRE-OUTCOME failure (it never
// legitimately executed) has NO product verdict; recovery acts on the failure, product metrics never see it.
// docs/architecture/batch-resilience.md + the trust-kernel CaseOutcome contract.
export type CaseOutcome =
  | { status: "completed"; verdict: boolean }
  // Executed cleanly but nothing pass-deciding was measured (observation-only graders, or every deciding
  // grader unmeasured) — excluded from pass rate, distinct from a FAIL.
  | { status: "unmeasured" }
  | { status: "infra_failed"; failure: CaseFailure };

export function caseOutcome(result: Pick<CaseResult, "scores" | "failure">): CaseOutcome {
  const failure = result.failure;
  if (failure && PRE_OUTCOME_STAGES.has(failure.stage)) return { status: "infra_failed", failure };
  const verdict = caseVerdict(result);
  return verdict === undefined ? { status: "unmeasured" } : { status: "completed", verdict };
}

// The scorecard's denominators, served — 841/970 (verdicted) and 841/1000 (requested) are different claims,
// and a single "pass rate" must never conflate them. `requested` is the batch's ask (cases × trials) when the
// caller knows it; a cancelled/unlaunched case has no result, so requested − executed is the skipped tally.
// Isomorphic to the contracts ScorecardOutcomesSchema.
export interface ScorecardOutcomes {
  executed: number; // results present
  gradeable: number; // legitimately executed (not infra_failed)
  verdicted: number; // gradeable with a product verdict
  passed: number;
  failed: number;
  infraFailed: number;
  unmeasured: number; // gradeable but nothing pass-deciding measured
  requested?: number;
}

export function scorecardOutcomes(sc: Pick<Scorecard, "results">, requested?: number): ScorecardOutcomes {
  const out: ScorecardOutcomes = {
    executed: sc.results.length,
    gradeable: 0,
    verdicted: 0,
    passed: 0,
    failed: 0,
    infraFailed: 0,
    unmeasured: 0,
    ...(requested !== undefined ? { requested } : {}),
  };
  for (const r of sc.results) {
    const o = caseOutcome(r);
    if (o.status === "infra_failed") {
      out.infraFailed++;
      continue;
    }
    out.gradeable++;
    if (o.status === "unmeasured") {
      out.unmeasured++;
      continue;
    }
    out.verdicted++;
    if (o.verdict) out.passed++;
    else out.failed++;
  }
  return out;
}
