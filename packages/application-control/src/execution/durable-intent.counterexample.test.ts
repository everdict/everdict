import { runExecutionId } from "@everdict/contracts";
import type { RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  type ExecutionAttemptStore,
  InMemoryExecutionAttemptStore,
  type OpenAttemptInput,
} from "../ports/execution-attempt-store.js";
import { openPhysicalAttempt } from "./open-physical-attempt.js";

// ── AUTHORITY BEFORE EFFECT: THE PROOF NOBODY RETURNS (arch-review 54, Phase 1) ──────────────────────
//
// Wave A fixed the ORDER. The backend now computes the external job id, reports it through `onReserved`, and
// awaits that callback before it creates anything; a rejection aborts the dispatch. That is the right
// sequence, and it is not yet a protocol, because nothing in it proves the reservation was WRITTEN.
//
// Three no-ops sit on the path, each individually defensible:
//
//   ① `openPhysicalAttempt` turns a ledger fault into `{ unisolated: true }` — no attemptId, dispatch
//      continues. Its comment defends this correctly for the RECORDING fence (a self-mint during a ledger
//      outage would re-activate the two-authority generation split), and then applies the same answer to the
//      managed lane, where it means "run untracked compute".
//   ② `stampWork` returns early when the handle has no attemptId: `if (!attempts || work.attemptId ===
//      undefined) return;`. Called from `onReserved`, so it RESOLVES, so the backend submits.
//   ③ `recordWork(): Promise<void>` updates by primary key with no affected-row check. Updating a row that
//      does not exist is indistinguishable from updating one that does.
//
// Compose them and the interleaving is: ledger down → no attemptId → hook succeeds → K8s Job created → process
// dies. The job runs, bills, and writes; the ledger has no row and no handle; and the exact-work control
// surface that replaced the case-id one can address exactly nothing. `killWork` needs a handle, and there is
// none — which is the state that surface's deletion assumed could not arise.
//
// `recordWork`'s own doc comment explains why it is best-effort:
//
//     "It is still best-effort because the alternative is failing a dispatch that already succeeded, which
//      would make the audit plane able to kill live work."
//
// That was TRUE while the stamp ran after the apply. Wave A moved it before, and the comment outlived the
// ordering it described: today a refused stamp costs a dispatch that has placed nothing. The asymmetry that
// justified swallowing is gone, and the swallow stayed.
//
// The invariant: a store RETURNS proof, and the effect requires that proof as an argument. See rule
// `protocol` L1.

const WORK = (over: Partial<RuntimeWorkRef> = {}): RuntimeWorkRef => ({
  tenant: "acme",
  runId: "evd-run-1",
  externalJobId: "everdict-c1-aaaa",
  ...over,
});

const INPUT: OpenAttemptInput = {
  executionId: runExecutionId("1"),
  tenant: "acme",
  kind: "run",
} as OpenAttemptInput;

// A ledger that is reachable for nothing — the transient outage, not the "no ledger wired" deployment.
const brokenLedger = (): ExecutionAttemptStore =>
  ({
    open: async () => {
      throw new Error("connection terminated unexpectedly");
    },
    transition: async () => false,
    reserveWork: async () => {
      throw new Error("no row");
    },
    markUnisolated: async () => {},
    list: async () => [],
    listForScorecard: async () => [],
  }) as unknown as ExecutionAttemptStore;

// RED as of efe3657e, observed: `promise resolved "{ unisolated: true }" instead of rejecting`.
// (The second case PASSES today and must keep passing — it is the degrade this change must not break.)
describe("[R54 PHASE-1 COUNTEREXAMPLE #1 — CLOSED] a managed execution whose ledger open failed is not dispatched", () => {
  it("refuses instead of returning an unnamed attempt the caller will run anyway", async () => {
    // The managed lane asks for a durable identity. A ledger it cannot reach is not a degraded identity, it
    // is none — and the caller's next step creates a cluster object.
    await expect(
      openPhysicalAttempt({ attempts: brokenLedger(), managed: true } as never, INPUT),
      "a ledger outage produced an attempt with no id, and the dispatch continued on it",
    ).rejects.toThrow();
  });

  it("still degrades for a lane that places no external work", async () => {
    // The in-process / diagnostic lane keeps today's behaviour: the attempt happened, it is unfenced, and
    // nothing outside this process is waiting to be addressed.
    const opened = await openPhysicalAttempt({ attempts: brokenLedger() } as never, INPUT);
    expect(opened.unisolated).toBe(true);
    expect(opened.attemptId).toBeUndefined();
  });
});

// RED as of efe3657e, observed:
//   promise resolved "undefined" instead of rejecting   (the no-op write reports success)
//   TypeError: attempts.reserveWork is not a function   (there is no proof to require)
describe("[R54 PHASE-1 COUNTEREXAMPLE #2 — CLOSED] a write a decision rests on returns proof, never void", () => {
  it("refuses to record a handle against an attempt row that does not exist", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    // No `open` — so this attempt id names nothing. Today the write is a silent no-op and its caller,
    // `onReserved`, reports success to the backend.
    await expect(
      attempts.reserveWork("evd-run-1#g1", WORK({ attemptId: "evd-run-1#g1" })),
      "recording a handle against a missing attempt row succeeded",
    ).rejects.toThrow();
  });

  it("returns the persisted intent when the row is there, so the caller has something to require", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const opened = await attempts.open(INPUT);
    const persisted = await attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId }));
    // The proof object is the whole point: `submit` will take it as a parameter, so there is no state in
    // which the effect runs without it and no hook to forget.
    expect(persisted.work.externalJobId).toBe("everdict-c1-aaaa");
  });
});
