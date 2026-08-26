import type { RunRecord } from "@everdict/contracts";
import { runExecutionId, storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { RunService } from "../run/run-service.js";
import { InMemoryIntermediateCleanupStore } from "./intermediate-cleanup-store.js";

// ── A LOSER MAY NOT REOPEN A WINNER'S SETTLED DEBT (arch-review 70 P1-high) ─────────────────────────
//
// The cleanup debt is EXECUTION-scoped, which is right for the thing it was built for: a retry's second
// staging joins the first attempt's refs, and one canonical settlement releases them all. What it also means
// is that winner, loser, retry and cancel all address ONE row — and `owe` reopened it unconditionally:
//
//     ON CONFLICT (operation_id) DO UPDATE SET … state = 'retained'
//
// So a speculative loser still in flight when the winner settled would stage late, flip the COMPLETED row
// back to `retained`, then lose its own commit and release nothing. A terminal execution ends holding a
// retained row, and `due()` never returns one:
//
//     winner: stage → win → release → completed
//     loser:  stage (late) → completed becomes retained → loses → nothing releases → kept forever
//
// The repair is not a bigger lock; it is reading what `retained` MEANS. It means "a recovery may still need
// these bytes". Once the execution has settled, that is false — so artifacts arriving afterwards are owed
// COLLECTABLE, and the reconciler takes them. Nothing is waiting for them, because the case they belong to
// is over.
//
// Seen RED before the reopen was guarded, observed:
//   a late loser reopened a settled execution's debt: expected 'retained' to be 'gc_owed'

const RUN = "evd-run-r1";
const EXECUTION = storedExecutionId(RUN);
const ref = (key: string) => ({ key, digest: `sha256:${key}` });

describe("[R70 COUNTEREXAMPLE] a settled execution cannot be dragged back into retention", () => {
  it("owes a LATE stage as collectable, not as retained, once the execution has completed", async () => {
    const cleanup = new InMemoryIntermediateCleanupStore();
    // The winner's whole life: stage, settle, sweep.
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref("agent-half/winner.json")] });
    await cleanup.releaseForGc("acme", EXECUTION);
    expect(await cleanup.complete("acme", EXECUTION), "the winner's debt did not complete").toBe(true);

    // A speculative loser, still in flight when the winner settled, stages its own half.
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref("agent-half/loser.json")] });

    const debt = cleanup.snapshot()[0];
    expect(debt?.state, "a late loser reopened a settled execution's debt").toBe("gc_owed");
    // …and the loser's bytes are IN the worklist, so the sweep takes them rather than nobody taking them.
    const due = await cleanup.due(new Date(Date.now() + 60_000).toISOString(), 50);
    expect(
      due.flatMap((d) => d.refs.map((r) => r.key)),
      "the loser's artifacts are owed to nobody",
    ).toContain("agent-half/loser.json");
  });

  it("owes a late stage as collectable while the debt is RELEASED but not yet swept", async () => {
    // The same reasoning one state earlier: `gc_owed` already means the settlement happened.
    const cleanup = new InMemoryIntermediateCleanupStore();
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref("a.json")] });
    await cleanup.releaseForGc("acme", EXECUTION);

    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref("late.json")] });

    expect(cleanup.snapshot()[0]?.state, "a released debt was dragged back into retention").toBe("gc_owed");
  });

  it("still RETAINS an ordinary second stage while the execution is live", async () => {
    // The control, and the behaviour the execution-scoped row exists for: the agent half and the verdict are
    // staged at different moments of a case that has not settled, and neither may be collectable yet.
    const cleanup = new InMemoryIntermediateCleanupStore();
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref("agent-half/a.json")] });
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref("verifier-verdict/b.json")] });

    const debt = cleanup.snapshot()[0];
    expect(debt?.state, "a live execution's artifacts became collectable mid-case").toBe("retained");
    expect(debt?.refs, "the second stage forgot the first").toHaveLength(2);
    // Nothing may be swept while the case runs.
    expect(await cleanup.due(new Date(Date.now() + 60_000).toISOString(), 50)).toHaveLength(0);
  });
});

// ── …AND A CANCEL IS AN ENDING TOO (arch-review 70 P1) ──────────────────────────────────────────────
//
// Release was wired to the normal canonical settlement and nowhere else. `RunService.cancel()` terminalized
// the run, converged its teardown, and never touched the cleanup ledger — grep for the discharge in that
// whole method returned ZERO. So a private-verifier run that had staged its half and its verdict ended
// CANCELLED with its debt still `retained`, which `due()` never returns: the artifacts of a case nobody will
// ever finish, kept forever, on the one path where it is most obvious nothing is coming back for them.
//
// Seen RED before the cancel released, observed:
//   a cancelled run left its staged artifacts owed to nobody: expected 'retained' to be 'gc_owed'

const cancelledRun = (id: string): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "cc", version: "1.0.0" },
  caseId: "case-1",
  status: "running",
  runtime: "nomad-dev",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
});

function runStore(records: RunRecord[]) {
  const rows = new Map(records.map((r) => [r.id, r]));
  return {
    async create(record: RunRecord) {
      rows.set(record.id, record);
    },
    async update(id: string, patch: Partial<RunRecord>) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      return next;
    },
    async get(id: string) {
      return rows.get(id);
    },
    async list() {
      return [...rows.values()];
    },
  } as never;
}

describe("[R70 COUNTEREXAMPLE] a cancelled run releases what it staged", () => {
  it("frees the intermediates of a case nobody will finish", async () => {
    const cleanup = new InMemoryIntermediateCleanupStore();
    const execution = runExecutionId("r1");
    const removed: string[] = [];
    await cleanup.owe({ tenant: "acme", executionId: execution, refs: [ref("agent-half/r1.json")] });
    await cleanup.confirm({ tenant: "acme", executionId: execution, keys: ["agent-half/r1.json"] });

    const service = new RunService({
      dispatcher: { dispatch: async () => ({}) } as never,
      store: runStore([cancelledRun("r1")]),
      cleanup,
      agentHalves: {
        async put(k: string) {
          return k;
        },
        async get() {
          return undefined;
        },
        async remove(k: string) {
          removed.push(k);
        },
      },
      killWork: async () => ({ status: "absent" as const }),
    } as never);

    await service.cancel({ tenant: "acme", id: "r1" });

    const debt = cleanup.snapshot()[0];
    expect(debt?.state, "a cancelled run left its staged artifacts owed to nobody").not.toBe("retained");
    expect(removed, "the cancelled run's staged half was never collected").toContain("agent-half/r1.json");
  });
});
