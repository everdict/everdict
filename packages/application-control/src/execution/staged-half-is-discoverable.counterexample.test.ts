import type { CaseJob, CaseResult, VerifierInvocation } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { IntermediateCleanupReconciler, cleanupRemover } from "../ops/intermediate-cleanup-reconciler.js";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import type { AgentHalfStore } from "./agent-half.js";
import { withVerifierPass } from "./verifier-pass.js";

// ── WINDOW B: DURABLE BYTES WITH NO DURABLE POINTER (arch-review 67 → 68) ──────────────────────────
//
// A crash between staging the agent half and RESERVING the verifier's work leaves the object store holding
// bytes that nothing addresses: the recovery finds a half by the digest a verifier work ref carries, and
// there is no verifier work ref — the reservation is what was about to happen. The recovery does not scan
// the store, so from its point of view the artifact is absent while the bytes sit there forever.
//
//     durable bytes exist  +  no durable pointer  =  operationally undiscoverable
//
// The cleanup ledger is that pointer. `owe` records the refs BEFORE the put and is keyed by EXECUTION rather
// than by any verifier coordinate, so the row survives the crash and names exactly what was written — which
// is what this file pins.
//
// ⚠️ WHAT THIS CLOSES AND WHAT IT DOES NOT, because the difference is the honest part. It closes the LEAK:
// the bytes are owed, the re-driven case's settlement releases them under the same execution id, and the
// reconciler collects them. It does NOT recover the agent's COMPUTE — the case re-runs the agent, and
// reusing a half whose verifier never reserved anything would mean merging a new verdict onto an older
// attempt's evidence, which is the cross-attempt hazard arch-review 61/62 closed by keying on the digest.
// Saving that compute is a mid-pass resume, not a pointer.
//
// Seen RED before the debt was recorded at stage time, observed:
//   the crashed attempt's half is owed to nobody: expected [] to have a length of 1

const RUN = "evd-run-r1";
const EXECUTION = storedExecutionId(RUN);

const JOB: CaseJob = {
  tenant: "acme",
  runId: RUN,
  harness: { id: "h", version: "1" },
  evalCase: {
    id: "c1",
    task: "t",
    env: { kind: "repo", source: { path: "/app" } },
    graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
    timeoutSec: 60,
    tags: [],
  },
} as unknown as CaseJob;

const resultWith = (text: string): CaseResult =>
  ({
    caseId: "c1",
    harness: "h@1",
    trace: [{ t: 0, kind: "log", stream: "stdout", text }],
    scores: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], base: "b", headSha: "h" },
  }) as unknown as CaseResult;

function objects() {
  const keys = new Map<string, Uint8Array>();
  return {
    keys: () => [...keys.keys()],
    async put(key: string, data: Uint8Array) {
      keys.set(key, data);
      return key;
    },
    async get(key: string) {
      return keys.get(key);
    },
    async remove(key: string) {
      keys.delete(key);
    },
  };
}

// The crash: the pass stages the half and the process dies before the verifier lane reserves anything. The
// lane throwing at its first instruction is that moment — the reservation has not happened, so nothing on
// the attempt ledger names this half.
const crashedBeforeReservation = async (store: AgentHalfStore, cleanup: InMemoryIntermediateCleanupStore) =>
  await withVerifierPass(JOB, {
    dispatch: async () => resultWith("the first attempt ran"),
    agentHalves: store,
    verdicts: store,
    cleanup,
    dispatchVerifier: async (): Promise<VerifierInvocation> => {
      throw new Error("the control plane died before this lane reserved anything");
    },
  } as never);

describe("[R68 COUNTEREXAMPLE] a half staged before any verifier reservation is still discoverable", () => {
  it("is OWED by the execution, not by a verifier coordinate that does not exist yet", async () => {
    const store = objects();
    const cleanup = new InMemoryIntermediateCleanupStore();

    await crashedBeforeReservation(store, cleanup);

    // The bytes are there…
    expect(
      store.keys().filter((k) => k.startsWith("agent-half/")),
      "nothing was staged",
    ).toHaveLength(1);
    // …and so is the row that names them, keyed by the EXECUTION — the coordinate that survives a crash the
    // verifier reservation never reached.
    const debts = cleanup.snapshot();
    expect(
      debts.flatMap((d) => d.refs).map((r) => r.key),
      "the crashed attempt's half is owed to nobody",
    ).toEqual(store.keys());
    expect(debts.map((d) => d.executionId)).toEqual([EXECUTION]);
    // Retained: the case has not settled, so no sweep may touch it yet.
    expect(debts.map((d) => d.state)).toEqual(["retained"]);
  });

  it("is COLLECTED when the re-driven case settles, under the same execution id", async () => {
    // The closure. The re-drive is a second physical attempt of the SAME logical execution, so its
    // settlement releases the row — which by then names both attempts' halves — and the sweep takes both.
    // That is why the debt is keyed by execution rather than by attempt: an attempt coordinate would have
    // left the crashed one owed to a row nobody settles.
    const store = objects();
    const cleanup = new InMemoryIntermediateCleanupStore();

    await crashedBeforeReservation(store, cleanup);
    // The re-drive: a different agent execution of the same case, which stages its own half.
    await withVerifierPass(JOB, {
      dispatch: async () => resultWith("the second attempt ran"),
      agentHalves: store,
      verdicts: store,
      cleanup,
      dispatchVerifier: async (): Promise<VerifierInvocation> => {
        throw new Error("still no verifier lane");
      },
    } as never);

    expect(store.keys(), "the two attempts collapsed onto one key, so this measures nothing").toHaveLength(2);

    // The settlement releases by execution, and the reconciler collects.
    await cleanup.releaseForGc("acme", EXECUTION);
    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: store, verdicts: store }),
    }).tick();

    expect(tick.completed).toBe(1);
    expect(store.keys(), "the crashed attempt's half outlived the case that settled").toEqual([]);
  });

  it("keeps the crashed half RETAINED while the re-drive is still running", async () => {
    // The control, and the reason retention is per-execution rather than per-attempt: while attempt two is
    // in flight, attempt one's half must not be collectable — a sweep taking it would be deleting evidence
    // of the very execution the case is about to settle.
    const store = objects();
    const cleanup = new InMemoryIntermediateCleanupStore();
    await crashedBeforeReservation(store, cleanup);

    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: store, verdicts: store }),
    }).tick();

    expect(tick.claimed, "a sweep claimed a half whose case has not settled").toBe(0);
    expect(store.keys()).toHaveLength(1);
  });
});
