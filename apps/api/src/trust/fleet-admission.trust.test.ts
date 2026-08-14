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

// Prove a scheduler does NOT admit, without betting the assertion on a fixed sleep (arch-review 18).
//
// A "does not happen" assertion cannot wait for a condition — it would pass trivially. The first version
// waited 250ms and asserted, which makes the certification load-sensitive: on a busy machine the pump had not
// yet reached the state being asserted about, and the scenario went red for a reason that had nothing to do
// with the invariant. A trust suite that cries wolf under load is a trust suite people learn to re-run.
//
// So: wait for the expected state to ARRIVE, then require it to HOLD across several polls. That is the same
// claim — nothing more is admitted — with the timing dependency removed from the failing direction.
async function holds(what: string, predicate: () => boolean | Promise<boolean>, checks = 3): Promise<void> {
  await until(`${what} (to be reached)`, predicate);
  for (let i = 0; i < checks; i++) {
    await new Promise((r) => setTimeout(r, 30));
    if (!(await predicate())) throw new Error(`${what}: held at first and then changed`);
  }
}

// These scenarios drive a REAL database through a scheduler pump, so the wall-clock cost is the database's,
// not the assertion's. Vitest's 5s default was close enough to the observed cost that a loaded machine failed
// the scenario for being slow rather than for being wrong — the same false-red the fixed-sleep barrier caused,
// arriving through the other door. Stated explicitly so a slow machine reads as slow.
const PG_SCENARIO_TIMEOUT_MS = 30_000;

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
    // The resolver is registered SYNCHRONOUSLY, alongside `dispatched` (arch-review 18). It used to be
    // pushed only after the row INSERT resolved, so `dispatched` and `pending` could disagree for a tick —
    // and a test that waited on `dispatched.length` and then called `releaseAll()` drained only the
    // resolvers that had arrived, leaving the rest unresolvable and the scenario hanging until the runner's
    // timeout. A false red, intermittently, in the suite whose whole job is to be believed.
    const created = this.runs.create(record);
    return new Promise<CaseResult>((resolve, reject) => {
      this.pending.push(() => {
        void created
          .then(() => this.runs.update(runId, { status: "succeeded", updatedAt: new Date().toISOString() }))
          .then(() =>
            resolve({
              caseId: caseJob.evalCase.id,
              harness: `${caseJob.harness.id}@${caseJob.harness.version}`,
              trace: [],
              snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
              scores: [],
            }),
          )
          .catch(reject);
      });
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

  let raceTenant: string;

  let retryTenant: string;

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-fleet");
    raceTenant = trustId("trust-race");
    retryTenant = trustId("trust-retry");
    runs = new PgRunStore(pg.client);
  });
  afterAll(async () => {
    for (const t of [tenant, raceTenant, retryTenant]) {
      if (!t) continue;
      await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [t]);
      await pg.client.query("DELETE FROM everdict_tenant_admissions WHERE tenant = $1", [t]);
      await pg.client.query("DELETE FROM everdict_tenant_admission_counters WHERE tenant = $1", [t]);
    }
    await pg?.close();
  }, PG_SCENARIO_TIMEOUT_MS);

  it(
    "replica B reads replica A's running rows and admits only the remainder — five in flight fleet-wide, not eight",
    async () => {
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
      // B places what the ledger leaves it and then keeps NOT placing — the claim is a refusal, so the state
      // has to be shown STABLE rather than merely observed once after an arbitrary delay.
      await holds("replica B to place exactly the two slots the ledger leaves", () => backendB.dispatched.length === 2);

      // Then: B admits only the 2 slots the ledger says are left. Pre-ledger, its empty local map said "0 in
      // flight" and it admitted all five, putting 8 of a 5-quota workspace's runs on real compute.
      expect(backendB.dispatched).toEqual(["B0", "B1"]);
      // …and the LEDGER shows five, which is a different observation from "B placed two" and has to be waited
      // on separately: the backend appends to its own list before the row commits, so a fleet-wide count read
      // the instant B's list settles can still be one insert behind. This scenario's own first wait says why —
      // the row is what the other replica reads, and it lands when it commits.
      await until(
        "the ledger to show the workspace's five slots in flight",
        async () => (await runs.inFlightByTenant())[tenant] === 5,
      );
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
    },
    PG_SCENARIO_TIMEOUT_MS,
  );

  it(
    "the SAME-INSTANT race cannot double-spend the quota — admission is an atomic permit, not a snapshot read",
    async () => {
      // The scenario above waits for A's rows to land before B starts, so it certifies the eventually-consistent
      // read and never the race: two replicas probing in the same instant both see the same headroom and — on
      // the snapshot alone — both admit. The permit (PgRunStore.tryAdmit: a counter-row UPDATE whose
      // `in_flight < quota` predicate re-evaluates on the LATEST row version under the row lock) is what makes
      // the quota a hard invariant, and only a real Postgres can prove that shape: a fake re-implements the
      // race away.
      const backendA = new LedgerWritingBackend("a", 10, runs);
      const backendB = new LedgerWritingBackend("b", 10, runs);
      const opts = { tenantQuota: () => 3, ledger: runs };
      const replicaA = new Scheduler(new BackendRegistry().register("a", backendA), opts);
      const replicaB = new Scheduler(new BackendRegistry().register("b", backendB), opts);

      // When: BOTH replicas burst concurrently — nothing has reached the ledger, so both snapshots read zero
      // in flight and the pre-filter waves everything through. Only the permit stands between 3 and 6.
      const pa = [0, 1, 2, 3].map((i) => replicaA.dispatch(job(raceTenant, `A${i}`)));
      const pb = [0, 1, 2, 3].map((i) => replicaB.dispatch(job(raceTenant, `B${i}`)));
      // The fleet admits the quota and then keeps NOT admitting — shown as a state that HOLDS, so the refusal
      // is not being inferred from an arbitrary delay on a loaded machine.
      await holds(
        "the fleet to admit exactly the quota and no more",
        () => backendA.dispatched.length + backendB.dispatched.length === 3,
      );

      // Then: exactly the quota is in flight, fleet-wide — not once per replica.
      expect(backendA.dispatched.length + backendB.dispatched.length).toBe(3);

      // And the limit throttles rather than strands: settling returns permits and the rest are admitted.
      for (let round = 0; round < 8; round++) {
        backendA.releaseAll();
        backendB.releaseAll();
        replicaA.poke();
        replicaB.poke();
        if (backendA.dispatched.length + backendB.dispatched.length >= 8) break;
        await new Promise((r) => setTimeout(r, 250)); // a progress nudge, not an assertion barrier
      }
      backendA.releaseAll();
      backendB.releaseAll();
      await Promise.all([...pa, ...pb]);
      expect(backendA.dispatched.length + backendB.dispatched.length).toBe(8);
      // Every permit returned — the counter holds no residue for the next batch to inherit. The release rides
      // the settle asynchronously (fire-and-forget, self-healed by the TTL reap if lost), so wait on the row.
      const counterOf = async (): Promise<number> => {
        const res = await pg.client.query<{ in_flight: number }>(
          "SELECT in_flight FROM everdict_tenant_admission_counters WHERE tenant = $1",
          [raceTenant],
        );
        return Number(res.rows[0]?.in_flight ?? 0);
      };
      await until("every admission permit to be returned", async () => (await counterOf()) === 0);
    },
    PG_SCENARIO_TIMEOUT_MS,
  );

  it(
    "a lost-response retry claims the counter at most once — in_flight always equals the live permit rows",
    async () => {
      // The retry shape: tryAdmit COMMITS, the response is lost, the scheduler re-asks with the SAME permit id
      // (the entry keeps it — scheduler.ts `permitId ??=`). Pre-fix the claim's counter arm fired again while
      // the permit INSERT was conflict-absorbed: in_flight reached 2 over one permit row, and the residue was
      // PERMANENT — release decremented once and the reap, with no row left to reap, never recovered the
      // phantom, silently shrinking the tenant's quota forever. The invariant certified here is CONSERVATION:
      // at every step, in_flight == count(live permit rows).
      const counters = async (): Promise<{ inFlight: number; permits: number }> => {
        const c = await pg.client.query<{ in_flight: number }>(
          "SELECT in_flight FROM everdict_tenant_admission_counters WHERE tenant = $1",
          [retryTenant],
        );
        const p = await pg.client.query<{ n: string | number }>(
          "SELECT count(*) AS n FROM everdict_tenant_admissions WHERE tenant = $1",
          [retryTenant],
        );
        return { inFlight: Number(c.rows[0]?.in_flight ?? 0), permits: Number(p.rows[0]?.n ?? 0) };
      };

      const permitId = trustId("permit");
      expect(await runs.tryAdmit(retryTenant, permitId, 2)).toBe(true);
      expect(await runs.tryAdmit(retryTenant, permitId, 2)).toBe(true); // the same right, re-answered
      expect(await counters()).toEqual({ inFlight: 1, permits: 1 });

      await runs.releaseAdmission(permitId);
      await runs.releaseAdmission(permitId); // double release is a no-op (deletes nothing → decrements nothing)
      expect(await counters()).toEqual({ inFlight: 0, permits: 0 }); // no phantom residue

      // And the freed quota is really free: two NEW permits fill it, a third is refused.
      expect(await runs.tryAdmit(retryTenant, trustId("p"), 2)).toBe(true);
      expect(await runs.tryAdmit(retryTenant, trustId("p"), 2)).toBe(true);
      expect(await runs.tryAdmit(retryTenant, trustId("p"), 2)).toBe(false);
      expect(await counters()).toEqual({ inFlight: 2, permits: 2 });
    },
    PG_SCENARIO_TIMEOUT_MS,
  );

  it(
    "the reap frees a lapsed lease but never a renewed one — a long run's permit survives, a dead holder's heals",
    async () => {
      // A permit is a LEASE, not a timestamp: reaping on wall-clock age took healthy permits out from under
      // running compute (quota INFLATION — the direction the ledger exists to close), while a renewed lease must
      // survive any age. Backdating renewed_at stands in for elapsed time; the sweep runs on the next admission.
      const leaseTenant = trustId("trust-lease");
      try {
        const dead = trustId("permit-dead");
        const live = trustId("permit-live");
        expect(await runs.tryAdmit(leaseTenant, dead, 5)).toBe(true);
        expect(await runs.tryAdmit(leaseTenant, live, 5)).toBe(true);
        await pg.client.query(
          "UPDATE everdict_tenant_admissions SET renewed_at = now() - interval '1 hour' WHERE permit_id IN ($1, $2)",
          [dead, live],
        );
        await runs.renewAdmissions([live]); // the live holder's heartbeat — the dead one stays lapsed

        // Any admission sweeps the fleet: the lapsed lease is reaped (counter decremented by exactly it), the
        // renewed one survives.
        expect(await runs.tryAdmit(leaseTenant, trustId("p"), 5)).toBe(true);
        const rows = await pg.client.query<{ permit_id: string }>(
          "SELECT permit_id FROM everdict_tenant_admissions WHERE tenant = $1 ORDER BY created_at",
          [leaseTenant],
        );
        expect(rows.rows.map((r) => r.permit_id)).not.toContain(dead);
        expect(rows.rows.map((r) => r.permit_id)).toContain(live);
        const counter = await pg.client.query<{ in_flight: number }>(
          "SELECT in_flight FROM everdict_tenant_admission_counters WHERE tenant = $1",
          [leaseTenant],
        );
        expect(Number(counter.rows[0]?.in_flight)).toBe(2); // live + the fresh admit; the dead lease healed
      } finally {
        await pg.client.query("DELETE FROM everdict_tenant_admissions WHERE tenant = $1", [leaseTenant]);
        await pg.client.query("DELETE FROM everdict_tenant_admission_counters WHERE tenant = $1", [leaseTenant]);
      }
    },
    PG_SCENARIO_TIMEOUT_MS,
  );
});
