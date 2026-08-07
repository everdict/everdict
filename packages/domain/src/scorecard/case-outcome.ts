import type { CaseFailure, CaseResult, Scorecard, VerdictPolicy } from "@everdict/contracts";
import { caseVerdict } from "./scorecard.js";
import { DEFAULT_VERDICT_POLICY, PRE_OUTCOME_STAGES } from "./verdict-policy.js";

// Case outcome — the case's fate as a first-class value, so "the agent failed the task" and "the platform
// failed the case" can never share a denominator. A result carrying a PRE-OUTCOME failure (it never
// legitimately executed) has NO product verdict; recovery acts on the failure, product metrics never see it.
// docs/architecture/batch-resilience.md + the trust-kernel CaseOutcome contract.
export type CaseOutcome =
  | { status: "completed"; verdict: boolean }
  // Executed cleanly but nothing pass-deciding was measured (observation-only graders, or every deciding
  // grader unmeasured) — excluded from pass rate, distinct from a FAIL.
  | { status: "unmeasured" }
  | { status: "infra_failed"; failure: CaseFailure }
  // The batch was stopped mid-case — neither the platform's fault nor the agent's outcome. A case with no
  // result at all is the OTHER cancellation shape (requested − executed); this one covers a killed case that
  // still left a classified result.
  | { status: "cancelled"; failure: CaseFailure };

export function caseOutcome(
  result: Pick<CaseResult, "scores" | "failure">,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): CaseOutcome {
  const failure = result.failure;
  // A user/supersede stop is CANCELLATION, not an infrastructure failure — recovery retries infra, never a
  // deliberate stop. Identified by the classified failure's code (the cancel paths stamp CANCELLED).
  if (failure?.code === "CANCELLED") return { status: "cancelled", failure };
  if (failure && PRE_OUTCOME_STAGES.has(failure.stage)) return { status: "infra_failed", failure };
  const verdict = caseVerdict(result, policy);
  return verdict === undefined ? { status: "unmeasured" } : { status: "completed", verdict };
}

// The scorecard's denominators, served — 841/970 (verdicted) and 841/1000 (requested) are different claims,
// and a single "pass rate" must never conflate them. `requested` is the batch's ask (cases × trials) when the
// caller knows it; a cancelled/unlaunched case has no result, so requested − executed is the skipped tally.
// Isomorphic to the contracts ScorecardOutcomesSchema.
export interface ScorecardOutcomes {
  executed: number; // results present
  gradeable: number; // legitimately executed (not infra_failed / cancelled)
  verdicted: number; // gradeable with a product verdict
  passed: number;
  failed: number;
  infraFailed: number;
  cancelled: number; // killed mid-case with a classified result (unlaunched cancels are requested − executed)
  unmeasured: number; // gradeable but nothing pass-deciding measured
  requested?: number;
}

// Judge-gradeability is a DIFFERENT question from verdict-legality: a judge needs a real trace/snapshot to
// read, so ANY classified failure (including collect — no trace) starves it, while the verdict only refuses
// pre-outcome failures (collect keeps its compute-bound measurements). One domain owner for each question —
// the scoring service delegates here instead of re-deriving the rule.
export function judgeGradeable(result: Pick<CaseResult, "failure">): boolean {
  return result.failure === undefined;
}

export function scorecardOutcomes(
  sc: Pick<Scorecard, "results">,
  requested?: number,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): ScorecardOutcomes {
  const out: ScorecardOutcomes = {
    executed: sc.results.length,
    gradeable: 0,
    verdicted: 0,
    passed: 0,
    failed: 0,
    infraFailed: 0,
    cancelled: 0,
    unmeasured: 0,
    ...(requested !== undefined ? { requested } : {}),
  };
  for (const r of sc.results) {
    const o = caseOutcome(r, policy);
    if (o.status === "cancelled") {
      out.cancelled++;
      continue;
    }
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
