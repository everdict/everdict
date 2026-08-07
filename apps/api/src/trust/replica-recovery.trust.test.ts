import { recoverInterrupted } from "@everdict/application-control";
import { PgReplicaRegistry, PgScorecardStore, type ScorecardRecord } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-09.
//
// The invariant: A BOOTING REPLICA NEVER EATS LIVE WORK. Startup recovery exists to reclaim batches whose
// driver died, and the moment the control plane scales past one process that sweep becomes dangerous: a
// second replica booting must reclaim the dead one's batches and leave the running one's batches alone.
// Getting this backwards kills a healthy in-flight eval and reports it as INTERRUPTED — a fabricated failure,
// which is the same class of lie as a fabricated number.
//
// Why only a real database can prove it: liveness is judged by the DATABASE's clock against a heartbeat row
// (`heartbeat_at > now() - staleMs`). A fake SqlClient can assert the SQL — it cannot assert that Postgres
// actually classifies a 10-second-old beat as alive and a 2-minute-old one as gone, nor that the record's
// `owner_replica` really round-trips through the jsonb-heavy scorecard row.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust(
  "TRUST-09 — startup recovery over real Postgres reclaims the dead replica's batch, not the live one's",
  () => {
    let pg: TrustPg;

    beforeAll(async () => {
      pg = await openTrustPg();
    });
    afterAll(async () => {
      await pg?.close();
    });

    it("a batch owned by a replica with a fresh heartbeat survives another replica's boot sweep; one owned by a stale replica is reclaimed", async () => {
      const tenant = trustId("trust-tenant");
      const liveReplica = trustId("replica-live");
      const deadReplica = trustId("replica-dead");
      const bootingReplica = trustId("replica-booting");

      // Given: two replicas that each inserted a running batch, stamped with themselves as the driver.
      const liveStore = new PgScorecardStore(pg.client, liveReplica);
      const deadStore = new PgScorecardStore(pg.client, deadReplica);
      const card = (id: string): ScorecardRecord => ({
        id,
        tenant,
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const livesOn = trustId("card-live");
      const orphaned = trustId("card-orphan");
      await liveStore.create(card(livesOn));
      await deadStore.create(card(orphaned));

      // And: the live replica is beating right now; the dead one's last beat is two minutes old.
      const registry = new PgReplicaRegistry(pg.client, { replicaId: bootingReplica, staleMs: 30_000 });
      await new PgReplicaRegistry(pg.client, { replicaId: liveReplica }).beat();
      await pg.client.query(
        `INSERT INTO everdict_control_plane_replicas (replica_id, started_at, heartbeat_at)
       VALUES ($1, now() - make_interval(secs => 300), now() - make_interval(secs => 120))`,
        [deadReplica],
      );

      try {
        // Sanity on the mechanism itself: the database's clock is what separates the two.
        const alive = await registry.liveReplicas();
        expect(alive).toContain(liveReplica);
        expect(alive).not.toContain(deadReplica);

        // When: a third replica boots and sweeps for orphaned work.
        const store = new PgScorecardStore(pg.client, bootingReplica);
        const result = await recoverInterrupted({ scorecards: store, owner: bootingReplica, replicas: registry });

        // Then: the live replica's batch was left alone — still running, still owned by its own driver.
        const survivor = await store.get(livesOn);
        expect(survivor?.status).toBe("running");
        expect(survivor?.ownerReplica).toBe(liveReplica);
        expect(result.live).toBeGreaterThanOrEqual(1);

        // And: the dead replica's batch was reclaimed and honestly tombstoned, not left running forever.
        const reclaimed = await store.get(orphaned);
        expect(reclaimed?.status).toBe("failed");
        expect(reclaimed?.error?.code).toBe("INTERRUPTED");
      } finally {
        await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]);
        await pg.client.query("DELETE FROM everdict_control_plane_replicas WHERE replica_id = ANY($1)", [
          [liveReplica, deadReplica, bootingReplica],
        ]);
      }
    });

    it("an unreadable heartbeat set reclaims nothing — we cannot prove anyone is dead, so nobody's work is taken", async () => {
      const tenant = trustId("trust-tenant-blind");
      const owner = trustId("replica-owner");
      const booting = trustId("replica-blind");
      const store = new PgScorecardStore(pg.client, owner);
      const id = trustId("card-blind");
      await store.create({
        id,
        tenant,
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      try {
        // Given: a registry whose liveness query fails — the database is up enough to hold records but the
        // heartbeat read is broken. This is the fail-closed branch: not knowing who is alive must never be read
        // as "nobody is".
        const blindRegistry = new PgReplicaRegistry(
          {
            query: async () => {
              throw new Error("heartbeat read failed");
            },
          },
          { replicaId: booting },
        );

        // When: a replica boots against that.
        const result = await recoverInterrupted({
          scorecards: new PgScorecardStore(pg.client, booting),
          owner: booting,
          replicas: blindRegistry,
        });

        // Then: nothing was reclaimed. Leaving a stale record for the next boot is recoverable; killing a live
        // batch is not.
        expect(result.scorecards).toBe(0);
        expect((await store.get(id))?.status).toBe("running");
        expect(result.live).toBeGreaterThanOrEqual(1);
      } finally {
        await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]);
      }
    });
  },
);
