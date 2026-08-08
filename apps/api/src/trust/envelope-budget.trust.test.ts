import { admitCausedWork } from "@everdict/application-control";
import { PaymentRequiredError, RateLimitError, type RunRecord } from "@everdict/contracts";
import { PgEnvelopeStore, PgRunStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-10.
//
// The invariant: DELEGATED WORK DRAWS FROM ITS DELEGATOR'S ENVELOPE, AND AN EXHAUSTED ENVELOPE REFUSES.
// An agent that spawns work is spending someone's budget. If caused work rode free on the tenant pool, the
// envelope would be a label rather than a boundary — the cap would print correctly while enforcing nothing,
// and a runaway automation would be discovered on the invoice.
//
// Three refusals are certified here, because an autonomy boundary that only stops ONE kind of runaway is not
// a boundary: money (402), unbounded fan-out depth (429), and a forged causer (400).
//
// Why only a real database can prove it: spend is READ FROM THE LEDGER — `PgEnvelopeStore.spend` aggregates
// admitted runs and settled cost across every replica, and the causal chain is walked through real run rows.
// A per-process counter agrees with itself no matter how many processes there are; the ledger is the only
// thing that can disagree, and disagreeing correctly is the whole point.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust(
  "TRUST-10 — envelope admission over real Postgres refuses exhausted budgets, runaway depth and forged causers",
  () => {
    let pg: TrustPg;
    let tenant: string;
    let runStore: PgRunStore;
    let envelopes: PgEnvelopeStore;

    beforeAll(async () => {
      pg = await openTrustPg();
      tenant = trustId("trust-envelope");
      runStore = new PgRunStore(pg.client);
      envelopes = new PgEnvelopeStore(pg.client);
    });
    afterAll(async () => {
      if (tenant) {
        await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [tenant]);
        await pg.client.query(
          "DELETE FROM everdict_envelope_admissions WHERE envelope_id IN (SELECT id FROM everdict_envelopes WHERE tenant = $1)",
          [tenant],
        );
        await pg.client.query("DELETE FROM everdict_envelopes WHERE tenant = $1", [tenant]);
      }
      await pg?.close();
    });

    // A run row as the delegating agent's run — the record that CARRIES the envelope.
    const run = async (over: Partial<RunRecord> & { id: string }): Promise<RunRecord> => {
      const record: RunRecord = {
        tenant,
        harness: { id: "scripted", version: "0" },
        caseId: "c1",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...over,
      };
      await runStore.create(record);
      return record;
    };

    it("caused work is refused once the delegated run cap is spent — 402, not a silent draw on the tenant pool", async () => {
      // Given: a delegating run holding an envelope capped at 2 caused runs.
      const delegator = trustId("run-delegator");
      await run({ id: delegator, envelope: { id: delegator, capRuns: 2 } });

      // When: the first two caused runs are admitted, they go through and are recorded against the envelope.
      const first = await admitCausedWork({ runStore, envelopes }, tenant, delegator, 1);
      expect(first?.id).toBe(delegator);
      await admitCausedWork({ runStore, envelopes }, tenant, delegator, 1);
      expect((await envelopes.spend(delegator)).runs).toBe(2);

      // Then: the third is refused — the cap is read from the ledger, so it holds no matter which replica asks.
      await expect(admitCausedWork({ runStore, envelopes }, tenant, delegator, 1)).rejects.toBeInstanceOf(
        PaymentRequiredError,
      );
    });

    it("a spent dollar cap refuses new work, and the refusal survives being asked from a second connection", async () => {
      // Given: an envelope capped in money, with the cost already settled onto the ledger.
      const delegator = trustId("run-usd");
      await run({ id: delegator, envelope: { id: delegator, capUsd: 1 } });
      await envelopes.settle(delegator, tenant, 1.25);

      // Then: refused — over budget is over budget.
      await expect(admitCausedWork({ runStore, envelopes }, tenant, delegator, 1)).rejects.toBeInstanceOf(
        PaymentRequiredError,
      );

      // And: a SECOND control-plane replica — its own store objects, its own connection, no shared memory —
      // reaches the same verdict. This is the multi-replica claim: the envelope is fleet-wide because the
      // spend lives in the database, not in whichever process happened to admit the earlier work.
      const otherReplica = { runStore: new PgRunStore(pg.client), envelopes: new PgEnvelopeStore(pg.client) };
      await expect(admitCausedWork(otherReplica, tenant, delegator, 1)).rejects.toBeInstanceOf(PaymentRequiredError);
    });

    it("TRUST-28: a same-instant burst on capRuns=1 admits EXACTLY ONE — the cap is an atomic claim, not a snapshot read", async () => {
      // The pre-fix sequence was spend() SELECT → JS compare → admit() upsert: two replicas both read 0,
      // both passed, both incremented — the exact count-then-act shape the tenant quota was rewritten to
      // close, left open on the one budget that bounds a delegated agent's autonomy. Only real Postgres can
      // certify the claim: the atomicity IS the predicate re-evaluating under the row lock.
      const delegator = trustId("run-race");
      await run({ id: delegator, envelope: { id: delegator, capRuns: 1 } });

      const replicaA = { runStore: new PgRunStore(pg.client), envelopes: new PgEnvelopeStore(pg.client) };
      const replicaB = { runStore: new PgRunStore(pg.client), envelopes: new PgEnvelopeStore(pg.client) };
      const results = await Promise.allSettled([
        admitCausedWork(replicaA, tenant, delegator, 1),
        admitCausedWork(replicaB, tenant, delegator, 1),
      ]);
      const admitted = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected" && r.reason instanceof PaymentRequiredError);
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((await envelopes.spend(delegator)).runs).toBe(1); // conservation: exactly the cap, never 2
    });

    it("TRUST-28: a retry with the SAME request id is the same right — one increment, ever", async () => {
      const delegator = trustId("run-retry");
      await run({ id: delegator, envelope: { id: delegator, capRuns: 3 } });
      const requestId = trustId("adm");
      await admitCausedWork({ runStore, envelopes }, tenant, delegator, 2, { requestId });
      // The lost-response shape: the caller re-asks with the identity it already holds.
      await admitCausedWork({ runStore, envelopes }, tenant, delegator, 2, { requestId });
      expect((await envelopes.spend(delegator)).runs).toBe(2); // held, never re-claimed
    });

    it("a runaway causal chain is refused on DEPTH before it is refused on money", async () => {
      // Given: a chain of runs each caused by the previous one — a recursive automation that never spends much
      // per hop. Money would notice this eventually; depth notices it now.
      let previous: string | undefined;
      for (let i = 0; i < 6; i++) {
        const id = trustId(`run-chain-${i}`);
        await run({ id, origin: previous ? { cause: "run", causedByRunId: previous } : { cause: "member" } });
        previous = id;
      }
      if (previous === undefined) throw new Error("chain not built");

      // Then: refused as a rate limit — retryable in shape, because the caller's mistake is recursion, not spend.
      await expect(
        admitCausedWork({ runStore, envelopes, maxCausalDepth: 4 }, tenant, previous, 1),
      ).rejects.toBeInstanceOf(RateLimitError);
    });

    it("a causer from another workspace is a bad request, never a silent pass — causation is an audited edge", async () => {
      const otherTenant = trustId("trust-other");
      const foreign = trustId("run-foreign");
      await runStore.create({
        id: foreign,
        tenant: otherTenant,
        harness: { id: "scripted", version: "0" },
        caseId: "c1",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      try {
        await expect(admitCausedWork({ runStore, envelopes }, tenant, foreign, 1)).rejects.toThrow(
          /does not name a run in this workspace/,
        );
      } finally {
        await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [otherTenant]);
      }
    });
  },
);
