import { type Backend, BackendRegistry, Scheduler } from "@everdict/backends";
import type { CaseJob, CaseResult, RunRecord } from "@everdict/contracts";
import { PgRunStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-07.
//
// The invariant: A WORKSPACE QUOTA IS FLEET-WIDE, NOT PER-PROCESS. A control plane of N replicas must hand a
// workspace its cap ONCE. Counting in-flight work in a per-process map gave every workspace N times its
// quota — the limit still printed the right number while enforcing N times it, which is a limit that lies.
//
// Why only a real database can prove it: the fleet count is one SQL predicate —
//   status = 'running' AND (kind IS NULL OR kind = 'eval') AND (lifetime IS NULL OR lifetime <> 'session')
// — and the whole guarantee rests on that predicate selecting exactly the rows the scheduler believes it
// selects. The unit test's hand-written ledger (scheduler.test.ts) counts a Map and would agree with ANY
// predicate, including a wrong one. Here two schedulers share one Postgres and the rows are real run rows.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

const job = (tenant: string, id: string): CaseJob => ({
  harness: { id: "scripted", version: "0" },
  tenant,
  evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
});

// The unit test's `flush()` (one macrotask) is not enough here: this scheduler's pump awaits a real database
// round-trip for its ledger reading, so progress takes milliseconds rather than ticks. Wait on the condition
// instead of on a fixed number of turns — and fail loudly rather than assert against a half-drained pump.
async function until(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

// Give the pump a chance to place anything MORE than it already has — for the assertions that must prove a
// scheduler does NOT admit, where waiting for a condition would pass trivially.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

// A backend that writes REAL run rows the way a dispatched case does: `running` while compute is held,
// terminal when it settles. Those rows — nothing else — are what the other replica's admission reads.
class LedgerWritingBackend implements Backend {
  readonly dispatched: string[] = [];
  private readonly pending: Array<() => void> = [];

  constructor(
    readonly id: string,
    private readonly total: number,
    private readonly runs: PgRunStore,
  ) {}

  async capacity() {
    return { total: this.total, used: 0 };
  }

  dispatch(caseJob: CaseJob): Promise<CaseResult> {
    const tenant = caseJob.tenant ?? "default";
    const runId = trustId("run");
    this.dispatched.push(caseJob.evalCase.id);
    const record: RunRecord = {
      id: runId,
      tenant,
      harness: caseJob.harness,
      caseId: caseJob.evalCase.id,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return new Promise<CaseResult>((resolve, reject) => {
      this.runs.create(record).then(
        () =>
          this.pending.push(() => {
            void this.runs.update(runId, { status: "succeeded", updatedAt: new Date().toISOString() }).then(() =>
              resolve({
                caseId: caseJob.evalCase.id,
                harness: `${caseJob.harness.id}@${caseJob.harness.version}`,
                trace: [],
                snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
                scores: [],
              }),
            );
          }),
        reject,
      );
    });
  }

  releaseAll(): void {
    while (this.pending.length > 0) this.pending.shift()?.();
  }
}

describeTrust("TRUST-07 — two scheduler replicas over one real run ledger hand out the workspace quota once", () => {
  let pg: TrustPg;
  let tenant: string;
  let runs: PgRunStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-fleet");
    runs = new PgRunStore(pg.client);
  });
  afterAll(async () => {
    if (tenant) await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [tenant]);
    await pg?.close();
  });

  it("replica B reads replica A's running rows and admits only the remainder — five in flight fleet-wide, not eight", async () => {
    // Given: two control-plane replicas, each with its own backend, sharing one Postgres run ledger.
    const backendA = new LedgerWritingBackend("a", 10, runs);
    const backendB = new LedgerWritingBackend("b", 10, runs);
    const opts = { tenantQuota: () => 5, ledger: runs };
    const replicaA = new Scheduler(new BackendRegistry().register("a", backendA), opts);
    const replicaB = new Scheduler(new BackendRegistry().register("b", backendB), opts);

    // When: replica A takes 3 of the workspace's 5 slots.
    const pa = [0, 1, 2].map((i) => replicaA.dispatch(job(tenant, `A${i}`)));
    // Wait on the LEDGER, not on the backend's own list: the row is what the other replica reads, and it
    // lands after the insert commits rather than when dispatch is entered.
    await until("A's three run rows to reach the ledger", async () => (await runs.inFlightByTenant())[tenant] === 3);
    expect(backendA.dispatched).toEqual(["A0", "A1", "A2"]);

    // … and replica B — which has placed nothing and whose own in-process count is zero — is handed 5 more.
    const pb = [0, 1, 2, 3, 4].map((i) => replicaB.dispatch(job(tenant, `B${i}`)));
    await until("replica B to place what it may", () => backendB.dispatched.length >= 2);
    await settle(); // and then keep NOT placing — the assertion below is about a refusal

    // Then: B admits only the 2 slots the ledger says are left. Pre-ledger, its empty local map said "0 in
    // flight" and it admitted all five, putting 8 of a 5-quota workspace's runs on real compute.
    expect(backendB.dispatched).toEqual(["B0", "B1"]);
    expect((await runs.inFlightByTenant())[tenant]).toBe(5);
    expect(replicaB.stats().queued).toBe(3);

    // And: settling frees the slots by LEAVING the ledger — there is no counter anywhere to reconcile, which
    // is the property that survives a replica dying mid-batch.
    backendA.releaseAll();
    await until("A's rows to leave the ledger", async () => (await runs.inFlightByTenant())[tenant] === 2);
    replicaB.poke(); // the other replica settled out-of-band; a poke tells this one to look again
    await until("replica B to place the rest", () => backendB.dispatched.length === 5);
    expect(backendB.dispatched).toEqual(["B0", "B1", "B2", "B3", "B4"]);

    backendB.releaseAll();
    await Promise.all([...pa, ...pb]);
    expect((await runs.inFlightByTenant())[tenant]).toBeUndefined();
  });
});
