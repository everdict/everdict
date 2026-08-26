import { runExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore, requireAdopted } from "../ports/execution-attempt-store.js";

// ── FIVE FACTS COLLAPSED INTO ONE NO-OP (arch-review 70 P2-protocol) ────────────────────────────────
//
// The standalone settlement stamped its attempt and threw the answer away, defending it in a comment: "the
// transition's own answer is deliberately unread: a refusal is a silent no-op by contract (an
// already-terminal row meeting a late stamp is ordinary)". That is right about ONE arm and wrong about the
// vocabulary. `false` collapses:
//
//     already terminal · revoked · failed · superseded · parent authorization refused
//
// and only the first is ordinary. The scorecard lane has consumed the semantic union since arch-review 66
// (`adoptAtSettlement` + `requireAdopted`); this lane kept the boolean, so one question had two protocols.
//
// ⚠️ NOT AN IMMEDIATELY REPRODUCIBLE DEFECT, and the review that found it rates it P2 for that reason: the
// stamp runs inside the same transaction as the run write and precedes it, and `PgRunStore.settleWith` orders
// things so a refused stamp rolls back with the fence. What was wrong was the VOCABULARY — a settlement that
// may not claim its attempt proceeding as though nothing had been asked.
//
// ⚠️ AND WHAT THIS FILE DOES NOT DO, said plainly rather than implied. It pins the DECISION the settlement
// now consumes, not the whole service path: `attemptStamp` is private and reachable only through the dispatch
// loop, and `settleAgentRun` — the one public settle — takes no stamp at all. A fixture that faked its way to
// `finalize` would prove less than nothing (rule `testing`: a counterexample drives production, or it says
// which part it drives). The end-to-end half belongs with the real Postgres settle path, where
// TRUST-182 already exercises `settleWith`'s rollback.
//
// Seen RED before the union was consumed, observed:
//   a superseded attempt was adopted as though nothing had been asked: expected 'incompatible_state' to be …

describe("[R70 COUNTEREXAMPLE] the arms a standalone settlement must tell apart", () => {
  const opened = async (run: string) => {
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: runExecutionId(run), tenant: "acme" });
    return { attempts, attemptId };
  };

  const adopt = async (attempts: InMemoryExecutionAttemptStore, attemptId: string, run: string) =>
    await attempts.adoptAtSettlement(attemptId, {
      parent: { kind: "run", id: run, adoptingEpoch: 0 },
      expectedExecutionId: runExecutionId(run),
      childRunId: run,
    });

  it("names SUPERSEDED as a state this settlement may not claim from", async () => {
    // The arm the boolean hid. Another driver took the compute over; the run may not settle on its attempt,
    // and the old code proceeded exactly as if the row had been adopted.
    const { attempts, attemptId } = await opened("r1");
    await attempts.transition(attemptId, "superseded");

    const outcome = await adopt(attempts, attemptId, "r1");

    expect(outcome.kind, "a superseded attempt was adopted as though nothing had been asked").toBe(
      "incompatible_state",
    );
    expect(() => requireAdopted(outcome, attemptId), "the settlement was allowed to proceed").toThrow();
  });

  it("names an ordinary ADOPTION as success", async () => {
    const { attempts, attemptId } = await opened("r2");
    const outcome = await adopt(attempts, attemptId, "r2");

    expect(outcome.kind).toBe("adopted");
    expect(() => requireAdopted(outcome, attemptId)).not.toThrow();
  });

  it("names a REPEAT of the same adoption as success, not as a refusal", async () => {
    // The arm the old comment was right about: an at-least-once settlement converging on the adoption it
    // already made is ordinary, and must not become an abort now that the answer is read.
    const { attempts, attemptId } = await opened("r3");
    await adopt(attempts, attemptId, "r3");

    const again = await adopt(attempts, attemptId, "r3");

    expect(again.kind, "a converging retry was read as a refusal").toBe("already_adopted");
    expect(() => requireAdopted(again, attemptId)).not.toThrow();
  });

  it("names an attempt belonging to ANOTHER execution rather than adopting it", async () => {
    // `wrong_parent`, the other arm that must abort: an attempt id is a string, and a wrong one names a real
    // row in somebody else's case (rule `protocol` L3).
    const { attempts, attemptId } = await opened("r4");

    const outcome = await attempts.adoptAtSettlement(attemptId, {
      parent: { kind: "run", id: "r-other", adoptingEpoch: 0 },
      expectedExecutionId: runExecutionId("r-other"),
      childRunId: "r-other",
    });

    expect(outcome.kind, "a settlement adopted another execution's attempt").not.toBe("adopted");
    expect(() => requireAdopted(outcome, attemptId)).toThrow();
  });
});
