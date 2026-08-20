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
  // ── CAN THE JUDGMENTS ON THIS CASE BE RE-INSPECTED? ──────────────────────────────────────────
  //
  // A verdict is a number; the account of how it was reached is what makes it defensible. Two ways that
  // account goes missing, and until now both were silent:
  //
  //   · a JUDGE ran and its own execution could not be sealed onto this run's trajectory (best-effort by
  //     contract — a lost seal must not lose a real verdict — but the loss used to be swallowed, so a
  //     judgment whose "how" is gone read exactly like one whose "how" is on file);
  //   · a VERIFIER produced the deciding verdict in a second container the lane could not name
  //     (`VerifierReceipt.complete`).
  //
  // "not_applicable" = nothing judged this case, so there is no account to be missing. That is different
  // from "complete", and collapsing them would make a case nobody judged look as well-evidenced as one
  // whose judges all sealed.
  judgment: "complete" | "partial" | "not_applicable";
}

// The empty prompt snapshot is the placeholder failedCaseResult synthesizes — not a captured world.
function snapshotPresent(result: Pick<CaseResult, "snapshot">): boolean {
  const s = result.snapshot;
  return !(s.kind === "prompt" && s.output === "");
}

export function evidenceStatus(
  result: Pick<CaseResult, "trace" | "snapshot"> &
    Pick<
      Partial<CaseResult>,
      "failure" | "traceRef" | "traceSealed" | "evidenceVersion" | "judgmentsSealed" | "verifier"
    >,
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
  return { trace, snapshot: snapshotPresent(result) ? "complete" : "missing", judgment: judgmentStatus(result) };
}

// Whether a judgment happened is read from the PRODUCER'S OWN STATEMENT, never from the scores. The first
// draft asked whether any metric started with `judge:` — which is deriving identity from a rendered label,
// the exact re-derivation rule `protocol` L3 forbids, and the raw-scores guard in this package pushed back
// on it before a human did. `judgmentsSealed` is set by the scorer precisely when it ran judges, and
// `verifier` is present precisely when a second container decided the case; both are born where the fact is.
//
// A row carrying NEITHER makes no statement about judgment, and `not_applicable` is what that says. On a
// pre-field row that is technically incomplete — it may well have been judged — and it is the honest answer
// available: the alternative is to infer from output what the producer never recorded.
function judgmentStatus(result: Pick<Partial<CaseResult>, "judgmentsSealed" | "verifier">): EvidenceStatus["judgment"] {
  const verifier = result.verifier;
  // A verdict reached in a container the lane could not name is an account nobody can re-open.
  if (verifier !== undefined && !verifier.complete) return "partial";
  if (result.judgmentsSealed === false) return "partial";
  if (result.judgmentsSealed === true || verifier !== undefined) return "complete";
  return "not_applicable";
}
