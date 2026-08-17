import type { ReplicaRegistry } from "@everdict/application-control";
import type { AdoptionDecision } from "@everdict/backends";
import type { RuntimeWorkRef } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore, type RunRecord } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { runStartupRecovery } from "./runtime-access.js";

// ── THE THIRD ANSWER, DISCARDED ONE LAYER ABOVE WHERE IT WAS PRODUCED (arch-review 54, Phase 2) ──────
//
// `adoptWorkFn` computes exactly the right thing and says so in its own comment:
//
//     // `unknown` leaves liveness unestablished — the caller must not re-dispatch on it (double-spend).
//     if (outcome.status === "unknown") established = false;
//     return { ...(harvested !== undefined ? { result: harvested } : {}), established };
//
// The caller, thirty lines down in `runStartupRecovery`, reads `outcome.result` and nothing else. `established`
// has never been consumed by anything. A `{ value?: T; ok: boolean }` pair lets a caller take the value and
// skip the flag, and this one did, for a full review cycle, under a comment explaining why it mattered.
//
// So a boot that cannot reach the cluster — or whose attempt-ledger read failed, since `workHandlesFor(...)
// .catch(() => [])` on the line above turns an unreadable ledger into "this run placed no compute" — proceeds
// to `service.resume(r, undefined, authority)`, which re-dispatches from the persisted caseSpec. The original
// job is still running. Two physical attempts of one logical execution now run concurrently: both bill, both
// call the provider, both write evidence, and a harness with external side effects fires them twice. The
// final row CAS picks one winner, and none of that is refundable.
//
// The `unknown-collapse-guard` scanner exists for exactly this and ALLOWLISTED it, reasoning:
//
//     "An unresolvable lane there falls back to RE-DISPATCH, which spends compute but cannot produce a wrong
//      verdict, and `AdoptOutcome.unknown` already carries the doubt for the case that matters."
//
// Both halves are wrong. Re-dispatch is not only cost, and the doubt `unknown` carries is discarded by the
// caller — which is what the allowlist entry was asserting could not happen. (The `.catch(() => [])` is not
// even matched by the scanner's patterns, which watch `attempts.list`, not `workHandlesFor`.)
//
// The invariant: adoption answers a union, recovery matches it exhaustively, and `unknown` PARKS the record
// for the next sweep rather than deciding anything. See rule `protocol` L2.

const runRec = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "h", version: "1" },
  caseId: "c1",
  status: "running",
  runtime: "rt-1",
  ownerReplica: "cp-dead",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  ...over,
});

const aliveReplicas = (ids: string[]): ReplicaRegistry => ({
  async beat() {},
  async liveReplicas() {
    return ids;
  },
  async leave() {},
});

const HANDLE: RuntimeWorkRef = { tenant: "acme", runId: "evd-run-orphan", externalJobId: "everdict-c1-aaaa" };

// Boot recovery with one orphaned run whose compute we hold a handle for, and a cluster that cannot answer.
async function recoverWith(adoption: AdoptionDecision): Promise<{ resumed: string[] }> {
  const runs = new InMemoryRunStore();
  const scorecards = new InMemoryScorecardStore();
  await runs.create(runRec("orphan"));
  const resumed: string[] = [];
  await runStartupRecovery({
    scorecardStore: scorecards,
    store: runs,
    owner: "cp-live",
    replicas: aliveReplicas(["cp-live"]), // the owner is gone, so this record is reclaimable
    scorecardService: { resume: async () => ({ kind: "resumed" }) } as never,
    service: {
      resume: async (r: RunRecord) => {
        resumed.push(r.id);
        return { kind: "resumed" } as never;
      },
    } as never,
    adoptWorkFn: async () => adoption,
    workHandlesFor: async () => [HANDLE],
  });
  // The background adoption leg is fire-and-forget; let its microtasks drain.
  await new Promise((r) => setTimeout(r, 10));
  return { resumed };
}

// RED as of efe3657e, observed: `expected [ 'orphan' ] to deeply equal []`.
describe("[R54 PHASE-2 COUNTEREXAMPLE #5 — CLOSED] an adoption that could not be established never re-dispatches", () => {
  it("leaves the run for the next sweep instead of resuming it", async () => {
    const { resumed } = await recoverWith({ kind: "unknown", reason: "the cluster could not be asked" });
    expect(
      resumed,
      "adoption answered `unknown` and recovery re-dispatched anyway — the original job may still be running",
    ).toEqual([]);
  });

  it("still re-dispatches when the cluster confirmed the job is gone", async () => {
    // The other half: `absent` IS establishable, and re-dispatch is the correct answer to it. A fix that
    // parks on every non-adoption would strand every genuinely dead run.
    const { resumed } = await recoverWith({ kind: "absent" });
    expect(resumed).toEqual(["orphan"]);
  });
});
