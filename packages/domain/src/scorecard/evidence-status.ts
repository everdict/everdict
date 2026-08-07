import { CURRENT_EVIDENCE_VERSION, type CaseResult } from "@everdict/contracts";
import { PRE_OUTCOME_STAGES } from "./verdict-policy.js";

// Evidence completeness as a VALUE — "we have evidence" and "the evidence is complete" are different claims,
// and a verdict standing on partial evidence must say so. Derived from what the result already records (the
// classified failure's stage + the evidence planes present), never self-reported. trust-kernel contract ⑤.
//
// trace:    complete = the producer vouched (traceSealed), or a pre-seal-era row with a trajectory
//           partial  = a collect-stage failure but SOME events survived (the partial-results-by-design path),
//                      or a sealed-era producer that did NOT vouch (ingest — nobody watched the collection)
//           missing  = no events (never executed, or collection died before anything landed)
//           deferred = collection intentionally moved to the control plane (traceRef) and not yet folded in
// snapshot: complete = a real environment snapshot; missing = the empty placeholder a failed case carries
export interface EvidenceStatus {
  trace: "complete" | "partial" | "missing" | "deferred";
  snapshot: "complete" | "missing";
}

// The empty prompt snapshot is the placeholder failedCaseResult synthesizes — not a captured world.
function snapshotPresent(result: Pick<CaseResult, "snapshot">): boolean {
  const s = result.snapshot;
  return !(s.kind === "prompt" && s.output === "");
}

export function evidenceStatus(
  result: Pick<CaseResult, "trace" | "snapshot"> &
    Pick<Partial<CaseResult>, "failure" | "traceRef" | "traceSealed" | "evidenceVersion">,
): EvidenceStatus {
  const failure = result.failure;
  // The agent's TRAJECTORY, not the platform's lifecycle marks: a deferred job still carries infra-plane
  // events (compute_released etc.), and counting those as "the trace" made the deferred state unreachable —
  // an uncollected case read as complete.
  const hasTrajectory = result.trace.some((event) => event.kind !== "infra");
  let trace: EvidenceStatus["trace"];
  if (failure && PRE_OUTCOME_STAGES.has(failure.stage)) {
    // never legitimately executed — whatever events exist are infra post-mortem, not the agent's trajectory
    trace = "missing";
  } else if (failure?.stage === "collect") {
    trace = hasTrajectory ? "partial" : "missing";
  } else if (result.traceSealed === true) {
    trace = "complete"; // the producer VOUCHED — the only positive claim of completeness
  } else if (result.traceRef && !hasTrajectory) {
    trace = "deferred"; // control-plane collection pending — absence is a state, not a loss
  } else if (hasTrajectory) {
    // Events with no seal and no recorded failure: absence of bad news is not completeness — a trace
    // truncated without a recorded collect failure looks exactly like this. The seal is only informative if
    // its producer COULD have set it, which is what the evidence era says: from CURRENT_EVIDENCE_VERSION on,
    // every producer stamps its era and seals when it can vouch, so an unsealed result is a producer
    // declining to vouch (an ingest, which never watched the collection) and reads PARTIAL. A row from an
    // older era carries no such statement, so it keeps the pre-seal heuristic reading rather than being
    // retroactively demoted.
    trace =
      result.traceSealed === false || (result.evidenceVersion ?? 1) >= CURRENT_EVIDENCE_VERSION
        ? "partial"
        : "complete";
  } else {
    trace = "missing";
  }
  return { trace, snapshot: snapshotPresent(result) ? "complete" : "missing" };
}
