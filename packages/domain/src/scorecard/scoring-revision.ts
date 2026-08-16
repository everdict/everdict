import type {
  CaseCommitReceipt,
  CaseResult,
  GateScoringPin,
  JudgmentReceipt,
  Score,
  ScoringRevision,
} from "@everdict/contracts";
import { encodeCaseKey } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";
import { caseObservationDigest } from "./case-result-digest.js";
import { childKey } from "./scoring-plan.js";

// Scoring identity (docs/architecture/experiment-identity: the JUDGMENT axis) — the pure decisions behind
// ScorecardRecord.scoring. The live score plane mutates in place on a re-score, so identity lives in an
// append-only revision ledger: each pass digests the plane it left behind, and consumers (gates, diffs,
// auditors) pin the digest they read instead of trusting a record id to keep meaning one judgment.

// The judgment projection of one score — what the pass CLAIMED, stripped of narration. `detail` (a judge's
// rationale prose) and `retryable` (recovery advice) explain a judgment without being one: hashing them
// would move scoring identity when a judge merely re-words itself. `status` is normalized to its explicit
// form so a measured row digests identically with and without the optional literal.
function judgmentOf(s: Score): Record<string, unknown> {
  if (s.status === "unmeasured" || s.status === "invalid")
    return { graderId: s.graderId, metric: s.metric, status: s.status, reason: s.reason };
  return {
    graderId: s.graderId,
    metric: s.metric,
    status: "measured",
    value: s.value,
    ...(s.pass !== undefined ? { pass: s.pass } : {}),
    ...(s.label !== undefined ? { label: s.label } : {}),
  };
}

// Digest of the FULL score plane — caseId#trial → judgment-projected scores, canonically ordered on both
// axes so storage order never moves identity (contentDigest canonicalizes object keys; score arrays are
// sorted here because array order is content).
export function scorePlaneDigest(results: CaseResult[]): string {
  const plane: Record<string, unknown[]> = {};
  for (const r of results) {
    const scores = [...r.scores].sort(
      (a, b) => a.metric.localeCompare(b.metric) || a.graderId.localeCompare(b.graderId),
    );
    plane[childKey(r.caseId, r.trial)] = scores.map(judgmentOf);
  }
  return contentDigest(plane);
}

// ── WHAT THE JUDGES READ (arch-review 46) ────────────────────────────────────────────────────────────
//
// The revision's OUTPUT half (`scorePlaneDigest`) has been pinned since arch-review 6. Its input half was
// not, and a verdict without its input is an answer with no recorded question: the receipt ledger vouches
// for each case's execution bytes, the judges read a hydrated copy of them, and nothing ever compared the
// two. A case re-driven between a pass's hydration and its settle lands a new canonical child — and the
// pass, holding the old copy, certifies verdicts about an execution the ledger has since replaced, with
// every digest in the record agreeing with itself.

// The observation SET, digested — canonically ordered pairs, so storage order is never identity. Shared by
// both sides of the comparison ON PURPOSE: a digest computed one way here and another way over the receipts
// would compare two spellings rather than two observations, which is the defect class this file keeps
// removing (the stage's `canonicalScores`, the receipt's parse-first `caseResultDigest`).
export function observationSetDigest(
  entries: ReadonlyArray<readonly [key: string, observationDigest: string]>,
): string {
  return contentDigest(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, digest]) => [key, digest]),
  );
}

// The plane's own observation set: childKey → the EXECUTION's digest (scores and judge:* evidence spans
// excluded — see caseObservationDigest), so a legitimate re-judgment of the same execution digests
// identically and only a change to what was observed moves it.
export function inputObservationSetDigest(results: readonly CaseResult[]): string {
  return observationSetDigest(results.map((r) => [childKey(r.caseId, r.trial), caseObservationDigest(r)] as const));
}

// WHETHER THE RECEIPT LEDGER COULD BE READ AT ALL — stated by the caller, never inferred from an empty
// array. "No receipts exist" and "the receipts could not be fetched" are opposite facts about a comparison,
// and collapsing them is how absence becomes agreement.
export type ReceiptLedgerReading =
  | { kind: "read"; receipts: ReadonlyArray<Pick<CaseCommitReceipt, "caseId" | "trial" | "observationDigest">> }
  | { kind: "unavailable"; reason: string };

// How many divergent units a revision names. Same bound and same reason as the stage-parity sample: a pass
// disagreeing on thousands has a systemic fault the first few describe as well as all of them.
const DIVERGED_CASE_SAMPLE = 50;

// The revision's input-observation record, decided at the one moment both halves are in hand.
//
// TOTAL BY CONSTRUCTION — it catches its own faults and reports them as `completed: false`. A measurement
// must never be able to fail the thing it measures (the same posture `stageObservationOf` settled on): this
// rides a settle, and a settle that dies because its self-check threw would trade a recorded doubt for an
// unrecorded one.
export function inputObservationOf(
  results: readonly CaseResult[],
  ledger: ReceiptLedgerReading,
): NonNullable<ScoringRevision["inputObservation"]> {
  let judged: Array<readonly [string, string]>;
  try {
    judged = results.map((r) => [childKey(r.caseId, r.trial), caseObservationDigest(r)] as const);
  } catch (err) {
    return {
      completed: false,
      failure: `the judged plane's own observations could not be digested (${err instanceof Error ? err.message : String(err)})`,
      cases: results.length,
    };
  }
  const setDigest = observationSetDigest(judged);
  if (ledger.kind === "unavailable")
    return { completed: false, failure: ledger.reason, setDigest, cases: judged.length };
  // Only receipts that actually CARRY an execution digest enter the map: one stamped before that half
  // existed vouches for the committed bytes wholesale (`resultDigest`), which a re-scored row diverges from
  // by design — reading it here would report tampering on every legitimately re-judged case.
  const vouched = new Map<string, string>();
  for (const r of ledger.receipts)
    if (r.observationDigest !== undefined) vouched.set(childKey(r.caseId, r.trial), r.observationDigest);
  // A PARTIAL rebuild is not the same set. A judged case with no receipt, or a receipt stamped before the
  // observation digest existed, leaves the comparison unable to speak for the whole plane — so it says so
  // instead of digesting the subset it happens to have and calling the two sets equal.
  const unvouched = judged.filter(([key]) => vouched.get(key) === undefined).map(([key]) => key);
  if (unvouched.length > 0)
    return {
      completed: false,
      failure: `${unvouched.length} of ${judged.length} judged case(s) have no receipt carrying an execution digest (${unvouched
        .slice(0, DIVERGED_CASE_SAMPLE)
        .join(", ")}) — this pass's inputs cannot be compared against the ledger`,
      setDigest,
      cases: judged.length,
    };
  const diverged = judged.filter(([key, digest]) => vouched.get(key) !== digest).map(([key]) => key);
  // Rebuilt over the JUDGED keys, not over every receipt in the batch: the question is whether this pass's
  // inputs are vouched for, and a receipt for a case this pass never judged is not part of that question.
  const vouchedPairs = judged.flatMap(([key]) => {
    const digest = vouched.get(key);
    return digest === undefined ? [] : [[key, digest] as const];
  });
  return {
    completed: true,
    setDigest,
    cases: judged.length,
    receiptSetDigest: observationSetDigest(vouchedPairs),
    diverged: diverged.length,
    ...(diverged.length > 0 ? { divergedCases: diverged.slice(0, DIVERGED_CASE_SAMPLE) } : {}),
  };
}

// ── WHOSE VERDICT THIS IS (arch-review 52 wave 5) ────────────────────────────────────────────────────
//
// The receipt vector's canonical ORDER — (case, judge), which is a total order over the vector because the
// stage holds exactly one row per (scorecard, pass, case, judge). Ordering is not content, so it is imposed
// here rather than inherited from whatever order the stage returned its rows in; the vector is stored in
// this order too, so what is read back is what was digested.
function orderedReceipts(receipts: readonly JudgmentReceipt[]): JudgmentReceipt[] {
  return [...receipts].sort((a, b) => {
    const byCase = encodeCaseKey(a.ref.case).localeCompare(encodeCaseKey(b.ref.case));
    return byCase !== 0 ? byCase : a.ref.judgeId.localeCompare(b.ref.judgeId);
  });
}

// The vector as ONE value — what a decision surface pins instead of carrying every receipt. Born with the
// vector inside `appendScoringRevision` for the same reason `scorePlaneDigest` is born with the plane: a
// digest a caller may compute separately is a digest that can describe a different set than the one stored.
export function judgmentReceiptSetDigest(receipts: readonly JudgmentReceipt[]): string {
  return contentDigest(orderedReceipts(receipts));
}

export interface ScoringPassInput {
  kind: ScoringRevision["kind"];
  judges: ScoringRevision["judges"];
  judgeRun?: NonNullable<ScoringRevision["judgeRun"]>;
  results: CaseResult[];
  analysisRef?: string;
  analysisKey?: string; // its durable object key (the ref expires; artifacts are pass-keyed)
  // How this pass's STAGE compared to the plane it is certifying (arch-review 16 P1-6) — the durable evidence
  // the stage promotion is gated on. Absent = no stage wired, or a revision from before it existed; readers
  // must treat that as UNOBSERVED, never as agreement.
  stageParity?: NonNullable<ScoringRevision["stageParity"]>;
  // WHERE the bytes above came from (arch-review 43 ①) — the carriers, or the stage this pass wrote. Absent =
  // the carriers, which is what every revision before the read-side switch means.
  stagePromotion?: NonNullable<ScoringRevision["stagePromotion"]>;
  // WHAT THIS PASS'S JUDGES READ — REQUIRED, and required on purpose (arch-review 46). `stageParity` shipped
  // optional and was then left off the very first append site that needed it; an optional field on a builder
  // this wide is a field that gets forgotten, and the forgetting is silent. Making it mandatory means the
  // compiler asks every append site the question, and a site with nothing to say answers `completed: false`
  // with its reason instead of answering nothing (`inputObservationOf` builds both shapes).
  inputObservation: NonNullable<ScoringRevision["inputObservation"]>;
  // WHICH INVOCATION AUTHORED EACH JUDGMENT (arch-review 52 wave 5) — one receipt per (case, judge) this
  // pass adopted, minted from the same stage read the parity observation is taken from. Undefined and `[]`
  // are DIFFERENT statements and both are kept: undefined = the vector could not be minted (no stage wired,
  // a pass with no identity), `[]` = this pass adopted nothing. Collapsing them would make "unrecorded" and
  // "none" the same evidence, which is the failure `inputObservation.completed` exists to prevent one field
  // over.
  judgments?: readonly JudgmentReceipt[];
  // The pass that produced it — the marker clears in the same write, so this is the only place the id survives.
  passId?: string;
  createdAt: string;
  createdBy?: string;
}

// The revision number the NEXT pass will bear — the one arithmetic owner (appendScoringRevision births the
// entry with this same number; offload sites name the per-revision artifact with it BEFORE the append, so
// the artifact key and the ledger entry can never disagree about which revision they describe).
export function nextScoringRevision(previous: ScoringRevision[] | undefined): number {
  return (previous?.at(-1)?.revision ?? 0) + 1;
}

// Append one scoring pass to the ledger — the ONLY way a revision is born, so numbering (strictly
// increasing, 1-based) and the plane digest cannot drift between the settle and re-score choke points.
export function appendScoringRevision(
  previous: ScoringRevision[] | undefined,
  input: ScoringPassInput,
): ScoringRevision[] {
  const prior = previous ?? [];
  return [
    ...prior,
    {
      revision: nextScoringRevision(prior),
      kind: input.kind,
      judges: input.judges,
      ...(input.judgeRun ? { judgeRun: input.judgeRun } : {}),
      scorePlaneDigest: scorePlaneDigest(input.results),
      ...(input.analysisRef !== undefined ? { analysisRef: input.analysisRef } : {}),
      // The artifact's durable KEY travels with its ref: the ref is a presigned URL that expires, and the
      // object is keyed by the writing PASS (two passes can target one revision), so the revision number no
      // longer names it. Dropping this here would leave every historical read holding a dead URL.
      ...(input.analysisKey !== undefined ? { analysisKey: input.analysisKey } : {}),
      // Named EXPLICITLY, like every other field here. This builder constructs the entry field by field, so
      // a caller spreading a new one in is silently dropped — a spread bypasses the excess-property check
      // that would otherwise catch it, which is exactly how this field went missing on its first attempt.
      ...(input.stageParity !== undefined ? { stageParity: input.stageParity } : {}),
      ...(input.stagePromotion !== undefined ? { stagePromotion: input.stagePromotion } : {}),
      // The vector and its digest are born together, in the canonical order they are digested under — so a
      // revision can never carry a set digest describing a set it does not hold.
      ...(input.judgments !== undefined
        ? {
            judgments: orderedReceipts(input.judgments),
            judgmentReceiptSetDigest: judgmentReceiptSetDigest(input.judgments),
          }
        : {}),
      inputObservation: input.inputObservation,
      ...(input.passId !== undefined ? { passId: input.passId } : {}),
      createdAt: input.createdAt,
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    },
  ];
}

// The pin a gate records for one side of a comparison — the CURRENT revision's identity at decision time.
// undefined when the record predates the ledger: absence is the honest answer, never a placeholder pin.
// It pins the INPUT half too (arch-review 46): a decision that records only the plane it read cannot answer
// whether that plane's verdicts describe the executions the ledger vouches for. The projection is a
// narrowing, never a re-derivation — the revision decided this at settle, with both halves in hand.
export function currentScoringPin(scoring: ScoringRevision[] | undefined): GateScoringPin | undefined {
  const last = scoring?.at(-1);
  if (!last) return undefined;
  const observed = last.inputObservation;
  return {
    revision: last.revision,
    scorePlaneDigest: last.scorePlaneDigest,
    ...(observed !== undefined
      ? {
          inputObservation: {
            ...(observed.setDigest !== undefined ? { setDigest: observed.setDigest } : {}),
            completed: observed.completed,
            ...(observed.diverged !== undefined ? { diverged: observed.diverged } : {}),
          },
        }
      : {}),
    // …and the PROVENANCE half (arch-review 52 wave 5): which invocations authored the judgments this
    // decision is about. A narrowing like the rest of this projection — the settle minted it, this only
    // carries it forward, so a disputed decision can be traced to the exact judge invocations it shipped on
    // rather than to a plane digest two invocations would share.
    ...(last.judgmentReceiptSetDigest !== undefined ? { judgmentReceiptSetDigest: last.judgmentReceiptSetDigest } : {}),
  };
}

// Does a pinned judgment KNOW its verdicts were derived from bytes the ledger no longer vouches for? Total,
// and deliberately conservative: only a COMPLETED observation reporting divergence answers yes. An absent or
// incomplete observation is unmeasured — a different fact, whose consequences its readers decide.
// ── THE INPUT'S TRUST CLASS, AS ONE VOCABULARY (arch-review 47 P0-3) ─────────────────────────────────
//
// Every decision surface (the CI gate, product readiness) classifies a pinned judgment's input the same
// way, so "recorded doubt" cannot pass one gate and block another:
//   receipt_vouched   — the observation completed and every judged case matched its receipt
//   diverged          — the observation completed and REPORTED divergence (never waivable)
//   unavailable       — the observation ran and could not vouch (ingest, ledger outage) — waivable only by
//                       the recorded allowUnverifiedInput policy
//   legacy_unverified — the revision predates input observation entirely. REFUSED by decision surfaces by
//                       default (owner decision, arch-review 47 follow-up: receipt-vouched input only) —
//                       waivable at the gate via allowUnverifiedInput, never at the release; a re-score
//                       produces an observed revision and makes the evidence vouched again
export type DecisionInputTrust = "receipt_vouched" | "diverged" | "unavailable" | "legacy_unverified";

export function decisionInputTrustOf(pin: GateScoringPin | undefined): DecisionInputTrust {
  const observed = pin?.inputObservation;
  if (observed === undefined) return "legacy_unverified";
  if (!observed.completed) return "unavailable";
  return observed.diverged !== undefined && observed.diverged > 0 ? "diverged" : "receipt_vouched";
}

export function scoringPinInputDiverged(pin: GateScoringPin | undefined): number | undefined {
  const observed = pin?.inputObservation;
  if (observed === undefined || !observed.completed) return undefined;
  return observed.diverged !== undefined && observed.diverged > 0 ? observed.diverged : undefined;
}
