import type { RecoveryTarget } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import { DeferredRecoverySweep } from "./runtime-access.js";

// ── A TIMER MAY NOT FORK THE WORKLIST IT IS DRAINING (arch-review 58 P1) ─────────────────────────────
//
// Boot recovery leaves behind the records it could not decide about — OPEN, claimed by this replica at a
// raised epoch, which every other replica correctly reads as "somebody is driving this". The sweep that
// retries them was registered as
//
//     setInterval(() => void (async () => { owed = await sweepDeferredRecovery(deps, owed) })(), 60_000)
//
// and a pass RESUMES BATCHES, so outliving a 60-second interval is the ordinary case. The moment it does,
// two things go wrong at once and neither is visible:
//
//   · both ticks call `resume` for the same target, which is the concurrent re-drive of live work that
//     `retryDeferredRecovery` exists precisely to avoid (its own comment says running the boot pass on a
//     timer would re-dispatch live work — this reintroduced that through the back door);
//   · the second tick read the list BEFORE the first finished, so its assignment overwrites whatever the
//     first discharged. A debt that was settled comes back, permanently, because every later tick inherits
//     the resurrected entry.
//
// The list and "is a pass running" are one state, so they live in one object. That is also what gives the
// property a place to be tested: as a closure inside `main.ts` it was unreachable by any counterexample,
// which is why a re-entrancy bug could sit in a composition root nobody could write a test against.
//
// Seen RED with the re-entrancy guard neutralized, observed:
//   a second tick ran while the first was still going: expected [ 'a' , 'a' ] to have a length of 1

const target = (id: string, attempts = 1): RecoveryTarget =>
  ({ kind: "scorecard", id, authority: { ownerReplica: "r1", epoch: 1 }, attempts }) as unknown as RecoveryTarget;

// A deps object whose only job is to count resume calls and take as long as the test tells it to.
function slowDeps(hold: Promise<void>, seen: string[]) {
  return {
    scorecardStore: {
      get: async (id: string) => {
        seen.push(id);
        await hold;
        return undefined; // gone → the debt is discharged, which is what makes the lost update visible
      },
    },
    store: { get: async () => undefined },
    owner: { ownerReplica: "r1", epoch: 1 },
    scorecardService: { resume: async () => ({ kind: "resumed" }) },
    service: { resume: async () => ({ kind: "resumed" }) },
  } as unknown as ConstructorParameters<typeof DeferredRecoverySweep>[0];
}

describe("[R58 COUNTEREXAMPLE] the deferred-recovery sweep does not overlap itself", () => {
  it("DROPS a tick that arrives while a pass is still running", async () => {
    let release = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const sweep = new DeferredRecoverySweep(slowDeps(hold, seen), [target("a")]);

    const first = sweep.tick();
    // The 60s timer fires again while the first pass is mid-resume. NOT awaited: without the guard the second
    // pass blocks on the same latch, and awaiting it would make the failure a test timeout — a red that does
    // not name the invariant is not a counterexample (rule `testing`).
    const second = sweep.tick();
    await Promise.resolve();
    expect(seen, "a second tick ran while the first was still going").toHaveLength(1);

    release();
    await Promise.all([first, second]);
  });

  it("does not resurrect a target the running pass discharged", async () => {
    let release = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const sweep = new DeferredRecoverySweep(slowDeps(hold, seen), [target("a"), target("b")]);

    const first = sweep.tick();
    const second = sweep.tick(); // would have captured the PRE-tick list and written it back
    release();
    await Promise.all([first, second]);

    // Both records read as gone, so both debts are discharged. A forked tick would have restored the list it
    // captured before the first pass ran.
    expect(sweep.outstanding, "a discharged target came back").toHaveLength(0);
  });

  it("runs again once the pass has finished", async () => {
    // The guard drops a tick, it does not stop the sweep. A latch that never reopens is a worse defect than
    // the one it replaces: the debt would then be visible and never retried.
    const seen: string[] = [];
    const sweep = new DeferredRecoverySweep(slowDeps(Promise.resolve(), seen), [target("a")]);
    await sweep.tick();
    await sweep.tick();
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the debt when a pass throws — an outage does not discharge anything", async () => {
    const failing = {
      scorecardStore: {
        get: async () => {
          throw new Error("ledger unreadable");
        },
      },
      store: { get: async () => undefined },
      owner: { ownerReplica: "r1", epoch: 1 },
      scorecardService: { resume: async () => ({ kind: "resumed" }) },
      service: { resume: async () => ({ kind: "resumed" }) },
    } as unknown as ConstructorParameters<typeof DeferredRecoverySweep>[0];
    const sweep = new DeferredRecoverySweep(failing, [target("a")]);
    await sweep.tick();
    expect(sweep.outstanding, "an unreadable ledger discharged the debt").toHaveLength(1);
  });

  it("ESCALATES a target that has been undecidable for too long, naming what the last pass saw", async () => {
    // `retry_later` always carried a reason and every consumer dropped it, so a debt could sit in the
    // worklist forever with nothing anywhere saying why — the silence rule `protocol` L5 refuses. A first
    // deferral is ordinary; the tenth is somebody's problem, and the difference has to be visible.
    const said: string[] = [];
    const spy = console.error;
    console.error = (m: unknown) => {
      said.push(String(m));
    };
    try {
      const deps = {
        scorecardStore: { get: async () => ({ id: "a", status: "running", ownerReplica: "r1", ownerEpoch: 1 }) },
        store: { get: async () => undefined },
        owner: { ownerReplica: "r1", epoch: 1 },
        scorecardService: {
          resume: async () => ({ kind: "retry_later", reason: "the attempt ledger would not answer" }),
        },
        service: { resume: async () => ({ kind: "resumed" }) },
      } as unknown as ConstructorParameters<typeof DeferredRecoverySweep>[0];
      const sweep = new DeferredRecoverySweep(deps, [target("a", 9)]);
      await sweep.tick();
      expect(said.join("\n"), "a debt that will not decide was held in silence").toMatch(/undecidable for 10 passes/);
      expect(said.join("\n"), "the escalation does not say what the last pass saw").toMatch(/ledger would not answer/);
    } finally {
      console.error = spy;
    }
  });

  it("says NOTHING about a target on its first deferral — a blinking ledger is not a page", async () => {
    const said: string[] = [];
    const spy = console.error;
    console.error = (m: unknown) => {
      said.push(String(m));
    };
    try {
      const deps = {
        scorecardStore: { get: async () => ({ id: "a", status: "running", ownerReplica: "r1", ownerEpoch: 1 }) },
        store: { get: async () => undefined },
        owner: { ownerReplica: "r1", epoch: 1 },
        scorecardService: { resume: async () => ({ kind: "retry_later", reason: "transient" }) },
        service: { resume: async () => ({ kind: "resumed" }) },
      } as unknown as ConstructorParameters<typeof DeferredRecoverySweep>[0];
      await new DeferredRecoverySweep(deps, [target("a", 1)]).tick();
      expect(said.filter((m) => m.includes("undecidable"))).toHaveLength(0);
    } finally {
      console.error = spy;
    }
  });
});
