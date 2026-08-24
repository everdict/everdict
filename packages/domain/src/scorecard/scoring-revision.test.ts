import type { CaseCommitReceipt, CaseResult, JudgmentReceipt, Score, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseObservationDigest } from "./case-result-digest.js";
import {
  appendScoringRevision,
  currentScoringPin,
  inputObservationOf,
  inputObservationSetDigest,
  judgmentReceiptSetDigest,
  scorePlaneDigest,
  scoringPinInputDiverged,
} from "./scoring-revision.js";

// Scoring identity (arch-review 6): the live score plane mutates in place on a re-score, so identity lives
// in an append-only revision ledger digesting the plane each pass left behind. These tests pin the digest's
// semantics (judgment, not narration; content, not storage order) and the ledger's append discipline.

function result(caseId: string, scores: Score[], trial?: number, trace: TraceEvent[] = []): CaseResult {
  return {
    caseId,
    harness: "h@1",
    trace,
    snapshot: { kind: "prompt", output: "done" },
    scores,
    ...(trial !== undefined ? { trial } : {}),
  };
}

// Every append states what its judges read — the fixtures below say "nothing vouched for it", which is the
// honest answer for a plane with no ledger behind it.
const unvouched = inputObservationOf([], { kind: "unavailable", reason: "no ledger in this fixture" });

const verdict = (value: number, pass: boolean): Score => ({ graderId: "j", metric: "judge:j", value, pass });

describe("scorePlaneDigest — the judgment plane, canonically", () => {
  it("is stable under storage order (case order and score order are not content)", () => {
    const a = [
      result("c1", [verdict(1, true), { graderId: "tests", metric: "tests_pass", value: 1, pass: true }]),
      result("c2", [verdict(0, false)]),
    ];
    const b = [
      result("c2", [verdict(0, false)]),
      result("c1", [{ graderId: "tests", metric: "tests_pass", value: 1, pass: true }, verdict(1, true)]),
    ];
    expect(scorePlaneDigest(a)).toBe(scorePlaneDigest(b));
  });

  it("moves when a judgment moves — a re-scored verdict is a different plane", () => {
    const before = [result("c1", [verdict(1, true)])];
    const after = [result("c1", [verdict(0, false)])];
    expect(scorePlaneDigest(before)).not.toBe(scorePlaneDigest(after));
  });

  it("ignores narration — a judge re-wording its rationale is the same judgment", () => {
    const unmeasured = (detail: string): Score => ({
      graderId: "j",
      metric: "judge:j",
      status: "unmeasured",
      reason: "grader_error",
      retryable: true,
      detail,
    });
    expect(scorePlaneDigest([result("c1", [unmeasured("transport died")])])).toBe(
      scorePlaneDigest([result("c1", [unmeasured("the LLM call timed out")])]),
    );
  });

  it("keeps trials apart — c1#0 and c1#1 are different rows of the plane", () => {
    expect(scorePlaneDigest([result("c1", [verdict(1, true)], 0), result("c1", [verdict(0, false)], 1)])).not.toBe(
      scorePlaneDigest([result("c1", [verdict(0, false)], 0), result("c1", [verdict(1, true)], 1)]),
    );
  });
});

describe("appendScoringRevision / currentScoringPin — the append-only ledger", () => {
  const results = [result("c1", [verdict(1, true)])];

  it("numbers passes 1-based and strictly increasing, preserving prior entries verbatim", () => {
    const first = appendScoringRevision(undefined, {
      kind: "initial",
      judges: [{ id: "j", version: "1.0.0", model: "m1" }],
      results,
      inputObservation: unvouched,
      createdAt: "t1",
      createdBy: "alice",
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ revision: 1, kind: "initial", createdBy: "alice" });
    const second = appendScoringRevision(first, {
      kind: "rescore",
      judges: [{ id: "j", version: "2.0.0", model: "m2" }],
      results: [result("c1", [verdict(0, false)])],
      inputObservation: unvouched,
      createdAt: "t2",
    });
    expect(second).toHaveLength(2);
    expect(second[0]).toEqual(first[0]); // append-only: history is never rewritten
    expect(second[1]).toMatchObject({ revision: 2, kind: "rescore" });
    expect(second[1]?.scorePlaneDigest).not.toBe(second[0]?.scorePlaneDigest);
  });

  it("pins the CURRENT revision for a gate, and pins nothing on a pre-ledger record", () => {
    const ledger = appendScoringRevision(undefined, {
      kind: "initial",
      judges: [],
      results,
      inputObservation: unvouched,
      judgmentsUnrecorded: "no judges ran in this fixture",
      createdAt: "t1",
    });
    expect(currentScoringPin(ledger)).toEqual({
      revision: 1,
      scorePlaneDigest: ledger[0]?.scorePlaneDigest,
      // …and WHO judged it, stated rather than omitted (arch-review 53, Wave D) — this pass recorded no
      // vector and says why, which is what makes "unrecorded" different from "nobody looked".
      judgmentProvenance: { kind: "unrecorded", reason: "no judges ran in this fixture" },
      // …and WHAT that judgment read, projected off the revision itself (arch-review 46)
      inputObservation: { completed: false, setDigest: unvouched.setDigest },
    });
    expect(currentScoringPin(undefined)).toBeUndefined();
    expect(currentScoringPin([])).toBeUndefined();
  });

  // The provenance half (arch-review 52 wave 5): a decision has to be able to say which judge INVOCATIONS it
  // shipped on. Two invocations that agree leave identical plane digests, so nothing else on the pin can.
  it("births the receipt vector with its own digest and carries that digest onto the gate's pin", () => {
    const receipt = {
      ref: { scoringPassId: "pass-1", case: { caseId: "c1" }, judgeId: "j", claim: { generation: 2, attempt: 1 } },
      scoreDigest: "sha256:score",
      evidenceEmitter: "judge:j#pass-1.2.1",
    };
    const ledger = appendScoringRevision(undefined, {
      kind: "rescore",
      judges: [],
      results,
      judgments: [receipt],
      inputObservation: unvouched,
      createdAt: "t1",
    });
    expect(ledger[0]?.judgments).toEqual([receipt]);
    expect(ledger[0]?.judgmentReceiptSetDigest).toBe(judgmentReceiptSetDigest([receipt]));
    expect(currentScoringPin(ledger)?.judgmentReceiptSetDigest).toBe(ledger[0]?.judgmentReceiptSetDigest);

    // An EMPTY vector is a measurement ("this pass adopted nothing") and gets a digest; an ABSENT one is a
    // revision that predates the vector, and must stay silent rather than be pinned as an empty judgment.
    const emptied = appendScoringRevision(undefined, {
      kind: "rescore",
      judges: [],
      results,
      judgments: [],
      inputObservation: unvouched,
      createdAt: "t1",
    });
    expect(emptied[0]?.judgments).toEqual([]);
    expect(emptied[0]?.judgmentReceiptSetDigest).toBe(judgmentReceiptSetDigest([]));
    expect(emptied[0]?.judgmentReceiptSetDigest).not.toBe(ledger[0]?.judgmentReceiptSetDigest);
    const legacy = appendScoringRevision(undefined, {
      kind: "rescore",
      judges: [],
      results,
      inputObservation: unvouched,
      createdAt: "t1",
    });
    expect(legacy[0]?.judgments).toBeUndefined();
    expect(currentScoringPin(legacy)?.judgmentReceiptSetDigest).toBeUndefined();
  });

  // Order is not content: the vector is stored and digested in one canonical (case, judge) order, so two
  // passes that adopted the same judgments cannot pin different digests over a map-iteration accident.
  it("orders the vector canonically, so the set digest is independent of the order the stage returned rows in", () => {
    const receiptFor = (caseId: string, judgeId: string): JudgmentReceipt => ({
      ref: { scoringPassId: "pass-1", case: { caseId }, judgeId },
      scoreDigest: `sha256:${caseId}-${judgeId}`,
      evidenceEmitter: `judge:${judgeId}#pass-1`,
    });
    const forward = [receiptFor("c1", "a"), receiptFor("c1", "b"), receiptFor("c2", "a")];
    const shuffled = [forward[2], forward[0], forward[1]].filter((r): r is JudgmentReceipt => r !== undefined);
    const of = (judgments: JudgmentReceipt[]) =>
      appendScoringRevision(undefined, {
        kind: "rescore",
        judges: [],
        results,
        judgments,
        inputObservation: unvouched,
        createdAt: "t1",
      })[0];
    expect(of(shuffled)?.judgments).toEqual(forward);
    expect(of(shuffled)?.judgmentReceiptSetDigest).toBe(of(forward)?.judgmentReceiptSetDigest);
  });

  it("carries the pass that wrote the revision — the marker clears in the same write", () => {
    const ledger = appendScoringRevision(undefined, {
      kind: "rescore",
      judges: [],
      results,
      inputObservation: unvouched,
      passId: "pass-7",
      createdAt: "t1",
    });
    expect(ledger[0]?.passId).toBe("pass-7");
  });
});

// ── WHAT THE JUDGES READ (arch-review 46) ────────────────────────────────────────────────────────────
//
// The revision pinned its own output and nothing about its input, so verdicts could be certified over an
// execution the receipt ledger had since replaced with every digest in the record agreeing with itself.

describe("inputObservationSetDigest — the execution set a pass judged", () => {
  const step: TraceEvent = { kind: "message", t: 0, role: "assistant", text: "step one" };

  it("is invariant under a re-score — the same executions, judged again, are the same input", () => {
    const executed = [result("c1", [verdict(1, true)], undefined, [step]), result("c2", [verdict(0, false)])];
    const reScored = [
      result("c1", [verdict(0, false)], undefined, [step]),
      result("c2", [
        { graderId: "j", metric: "judge:j", status: "unmeasured", reason: "grader_error", retryable: false },
      ]),
    ];
    expect(inputObservationSetDigest(reScored)).toBe(inputObservationSetDigest(executed));
    // …and it is emphatically NOT the plane digest: the judgments did move
    expect(scorePlaneDigest(reScored)).not.toBe(scorePlaneDigest(executed));
  });

  it("moves when the TRACE moves — a different execution is a different input", () => {
    const before = [result("c1", [verdict(1, true)], undefined, [step])];
    const after = [
      result("c1", [verdict(1, true)], undefined, [{ kind: "message", t: 0, role: "assistant", text: "step two" }]),
    ];
    expect(inputObservationSetDigest(after)).not.toBe(inputObservationSetDigest(before));
  });

  it("is stable under storage order and keeps trials apart", () => {
    const a = [result("c1", [], 0, [step]), result("c1", [], 1)];
    const b = [result("c1", [], 1), result("c1", [], 0, [step])];
    expect(inputObservationSetDigest(a)).toBe(inputObservationSetDigest(b));
    // c1#0 and c1#1 are different rows: swapping which trial saw which trace is a different set
    const swapped = [result("c1", [], 0), result("c1", [], 1, [step])];
    expect(inputObservationSetDigest(swapped)).not.toBe(inputObservationSetDigest(a));
  });
});

describe("inputObservationOf — the judgment's input, checked against the ledger", () => {
  const step: TraceEvent = { kind: "message", t: 0, role: "assistant", text: "step one" };
  const judged = [result("c1", [verdict(1, true)], undefined, [step]), result("c2", [verdict(0, false)])];

  function receipt(caseId: string, observationDigest?: string): CaseCommitReceipt {
    return {
      scorecardId: "sc-1",
      caseId,
      trial: 0,
      childRunId: `child-${caseId}`,
      resultDigest: `sha256:result-${caseId}`,
      ...(observationDigest !== undefined ? { observationDigest } : {}),
      committedAt: "t0",
    };
  }

  const vouching = judged.map((r) => receipt(r.caseId, caseObservationDigest(r)));

  it("agrees with the ledger — the set digest IS the receipts-rebuilt digest", () => {
    const observed = inputObservationOf(judged, { kind: "read", receipts: vouching });
    expect(observed.completed).toBe(true);
    expect(observed.diverged).toBe(0);
    expect(observed.cases).toBe(2);
    expect(observed.setDigest).toBe(inputObservationSetDigest(judged));
    expect(observed.receiptSetDigest).toBe(observed.setDigest);
    expect(observed.divergedCases).toBeUndefined();
  });

  it("NAMES the case whose judged bytes are not the ones its receipt vouches for", () => {
    // Given c1 was re-driven after this pass hydrated it — the ledger now vouches for a different execution
    const reDriven = [...vouching.slice(1), receipt("c1", caseObservationDigest(result("c1", [], undefined, [])))];
    const observed = inputObservationOf(judged, { kind: "read", receipts: reDriven });
    expect(observed.completed).toBe(true);
    expect(observed.diverged).toBe(1);
    expect(observed.divergedCases).toEqual(["c1#0"]);
    // …and the two digests disagree, which is the statement a gate can act on without reading the list
    expect(observed.receiptSetDigest).not.toBe(observed.setDigest);
  });

  it("states that LEGACY receipts cannot answer — absence of an execution digest is not agreement", () => {
    const observed = inputObservationOf(judged, { kind: "read", receipts: judged.map((r) => receipt(r.caseId)) });
    expect(observed.completed).toBe(false);
    expect(observed.failure).toContain("no receipt carrying an execution digest");
    expect(observed.diverged).toBeUndefined();
    // The plane's own digest still stands — only the comparison is missing
    expect(observed.setDigest).toBe(inputObservationSetDigest(judged));
  });

  it("refuses a PARTIAL rebuild — one judged case with no receipt voids the comparison, not just its row", () => {
    const observed = inputObservationOf(judged, { kind: "read", receipts: [vouching[0] as CaseCommitReceipt] });
    expect(observed.completed).toBe(false);
    expect(observed.receiptSetDigest).toBeUndefined();
    expect(observed.failure).toContain("c2#0");
  });

  it("carries the caller's reason when the ledger could not be read at all", () => {
    const observed = inputObservationOf(judged, { kind: "unavailable", reason: "the receipt ledger read failed" });
    expect(observed).toMatchObject({ completed: false, failure: "the receipt ledger read failed", cases: 2 });
  });
});

describe("scoringPinInputDiverged — only a completed observation may accuse", () => {
  const pin = (inputObservation?: { completed: boolean; diverged?: number }) => ({
    revision: 1,
    scorePlaneDigest: "sha256:plane",
    ...(inputObservation ? { inputObservation } : {}),
  });

  it("reports the count when a completed observation found divergence", () => {
    expect(scoringPinInputDiverged(pin({ completed: true, diverged: 2 }))).toBe(2);
  });

  it("stays silent on agreement, on an incomplete observation, and on a pre-ledger pin", () => {
    expect(scoringPinInputDiverged(pin({ completed: true, diverged: 0 }))).toBeUndefined();
    expect(scoringPinInputDiverged(pin({ completed: false, diverged: 3 }))).toBeUndefined();
    expect(scoringPinInputDiverged(pin())).toBeUndefined();
    expect(scoringPinInputDiverged(undefined)).toBeUndefined();
  });
});
