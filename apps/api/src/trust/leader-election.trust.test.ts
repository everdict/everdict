import { PgLeaderElector } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-08.
//
// The invariant: A SINGLETON LOOP HAS AT MOST ONE OWNER, AND LOSING THE OWNER IS NOT LOSING THE LOOP. Two
// replicas racing for the same role must not both believe they lead (that is a scheduler running twice), and
// a leader that shuts down must not take the loop with it for a whole TTL.
//
// Why only a real database can prove it: the whole mechanism is one atomic upsert whose WHERE clause compares
// the row's `expires_at` against the DATABASE's `now()`. A fake SqlClient can assert the SQL text — it cannot
// assert that Postgres actually refuses the second claimant, nor that an expired lease actually becomes
// claimable when the server's clock passes it.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-08 — leader election over real Postgres: one holder, immediate handover, TTL takeover", () => {
  let pg: TrustPg;

  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => {
    await pg?.close();
  });

  it("two replicas claim one role and exactly one leads; releasing hands over at once instead of stalling for a TTL", async () => {
    // Given: two control-plane replicas contending for the same singleton role.
    const role = trustId("trust-role");
    const alice = new PgLeaderElector(pg.client, { role, holder: "alice", ttlMs: 60_000, renewMs: 20_000 });
    const bob = new PgLeaderElector(pg.client, { role, holder: "bob", ttlMs: 60_000, renewMs: 20_000 });

    try {
      // When: both start.
      await alice.start();
      await bob.start();

      // Then: exactly one of them leads. The loser is not "maybe leading" — it stood down.
      expect([alice.isLeader(), bob.isLeader()].filter(Boolean)).toHaveLength(1);
      const leader = alice.isLeader() ? alice : bob;
      const follower = alice.isLeader() ? bob : alice;

      // And: the follower renewing again does not steal a live lease, however often it retries.
      await follower.start();
      await follower.start();
      expect(follower.isLeader()).toBe(false);
      expect(leader.isLeader()).toBe(true);

      // When: the leader shuts down cleanly (the rolling-restart path).
      await leader.stop();
      expect(leader.isLeader()).toBe(false);

      // Then: the follower takes over on its very next renewal — the lease was HANDED BACK, so nobody waits
      // out the 60s TTL to resume a loop that has no owner.
      await follower.start();
      expect(follower.isLeader()).toBe(true);
    } finally {
      await alice.stop().catch(() => undefined);
      await bob.stop().catch(() => undefined);
    }
  });

  it("a leader that dies without releasing is replaced once its lease expires, and not one moment before", async () => {
    // Given: a leader that vanished without calling stop() — a crash, an OOM kill, a severed network. A dead
    // process runs no code, so the faithful simulation is the only thing it leaves behind: its lease row,
    // still unexpired by the database's own clock. (Written directly for that reason — an elector object here
    // would keep renewing and never be dead.)
    const role = trustId("trust-role-crash");
    await pg.client.query(
      `INSERT INTO everdict_control_plane_leases (role, holder, acquired_at, renewed_at, expires_at)
       VALUES ($1, 'crashed', now(), now(), now() + make_interval(secs => 1))`,
      [role],
    );
    const successor = new PgLeaderElector(pg.client, { role, holder: "successor", ttlMs: 30_000, renewMs: 10_000 });

    try {
      // When: the successor tries immediately, while the dead leader's lease is still live.
      await successor.start();
      // Then: it is refused. "The holder stopped answering" is not proof it is gone — only expiry is.
      expect(successor.isLeader()).toBe(false);

      // When: the lease expires by the DATABASE's clock.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await successor.start();

      // Then: the successor takes the role over — the loop resumes without an operator in the loop.
      expect(successor.isLeader()).toBe(true);
      const held = await pg.client.query<{ holder: string }>(
        "SELECT holder FROM everdict_control_plane_leases WHERE role = $1",
        [role],
      );
      expect(held.rows[0]?.holder).toBe("successor");
    } finally {
      await successor.stop().catch(() => undefined);
      await pg.client.query("DELETE FROM everdict_control_plane_leases WHERE role = $1", [role]);
    }
  });
});
