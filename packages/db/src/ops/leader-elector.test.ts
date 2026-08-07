import { soleLeader, whenLeader } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgLeaderElector } from "./leader-elector.js";

// A fake Postgres that models the ONE thing the lease depends on: the upsert's WHERE admits only the current
// holder or an expired lease, judged by the database's own clock. Everything else about the statement is
// asserted separately below.
function fakeLeaseTable(clock: { ms: number }): { client: SqlClient; row: () => Lease | undefined } {
  let lease: Lease | undefined;
  const client: SqlClient = {
    async query(text, params) {
      const [role, holder, ttlSec] = (params ?? []) as [string, string, number];
      if (text.startsWith("DELETE")) {
        if (lease?.role === role && lease.holder === holder) lease = undefined;
        return { rows: [] as never[] };
      }
      const free = lease === undefined || lease.role !== role || lease.expiresAtMs <= clock.ms;
      if (!free && lease?.holder !== holder) return { rows: [] as never[] }; // somebody else holds a live lease
      lease = { role, holder, expiresAtMs: clock.ms + ttlSec * 1000 };
      return { rows: [{ holder }] as never[] };
    },
  };
  return { client, row: () => lease };
}

interface Lease {
  role: string;
  holder: string;
  expiresAtMs: number;
}

const elector = (client: SqlClient, holder: string, clock: { ms: number }) =>
  new PgLeaderElector(client, {
    role: "control-plane",
    holder,
    ttlMs: 30_000,
    renewMs: 10_000,
    now: () => clock.ms,
  });

describe("PgLeaderElector — one leader for the control plane's singleton loops", () => {
  it("elects exactly one of two replicas contending for the same role", async () => {
    const clock = { ms: 1_000 };
    const { client } = fakeLeaseTable(clock);
    const a = elector(client, "replica-a", clock);
    const b = elector(client, "replica-b", clock);

    await a.start();
    await b.start();

    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false); // the loser keeps its timer and no-ops — it does not throw or retry-storm
  });

  it("stands down as soon as it loses the lease — a follower never keeps acting", async () => {
    const clock = { ms: 1_000 };
    const { client } = fakeLeaseTable(clock);
    const a = elector(client, "replica-a", clock);
    await a.start();
    expect(a.isLeader()).toBe(true);

    // The leader goes away long enough for its lease to expire and another replica takes it.
    clock.ms += 60_000;
    const b = elector(client, "replica-b", clock);
    await b.start();
    expect(b.isLeader()).toBe(true);

    // The old leader comes back and finds the role taken.
    await a.start();
    expect(a.isLeader()).toBe(false);
  });

  it("believes it is leader for less than the lease lives, so a stalled renewal stops it before a takeover", async () => {
    const clock = { ms: 1_000 };
    const { client, row } = fakeLeaseTable(clock);
    const a = elector(client, "replica-a", clock);
    await a.start();

    clock.ms += 21_000; // past ttl − renew (20s), still inside the 30s the row lives
    expect(a.isLeader()).toBe(false); // it has already stopped acting …
    expect(row()?.expiresAtMs).toBeGreaterThan(clock.ms); // … while nobody else may take over yet
  });

  it("keeps a lease it already earned through a database blip, and lets it decay if the outage lasts", async () => {
    const clock = { ms: 1_000 };
    const { client } = fakeLeaseTable(clock);
    let failing = false;
    const flaky: SqlClient = {
      query: (text, params) =>
        failing ? Promise.reject(new Error("connection terminated")) : client.query(text, params),
    };
    const a = elector(flaky, "replica-a", clock);
    await a.start();

    failing = true;
    clock.ms += 10_000;
    await a.start(); // a renewal that cannot reach the database
    expect(a.isLeader()).toBe(true); // nobody else can take the lease before it expires either

    clock.ms += 15_000; // the outage outlives the margin
    expect(a.isLeader()).toBe(false); // fail-closed: it stops acting on its own
  });

  it("hands the lease back on shutdown so failover is immediate, not TTL-bound", async () => {
    const clock = { ms: 1_000 };
    const { client, row } = fakeLeaseTable(clock);
    const a = elector(client, "replica-a", clock);
    await a.start();

    await a.stop();

    expect(a.isLeader()).toBe(false);
    expect(row()).toBeUndefined();
    const b = elector(client, "replica-b", clock);
    await b.start();
    expect(b.isLeader()).toBe(true); // no waiting out the 30s TTL
  });

  it("claims with the database's own clock — never the replica's", async () => {
    const clock = { ms: 1_000 };
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [{ holder: "replica-a" }] as never[] };
      },
    };
    await elector(client, "replica-a", clock).start();

    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("INSERT INTO everdict_control_plane_leases");
    expect(sql).toContain("ON CONFLICT (role) DO UPDATE");
    expect(sql).toContain("expires_at < now()"); // expiry is judged by the database, not by a replica
    expect(calls[0]?.params).toEqual(["control-plane", "replica-a", 30]);
  });
});

describe("whenLeader — the gate the singleton loops run under", () => {
  it("runs the loop on the leader and skips it everywhere else", () => {
    let ran = 0;
    const follower = { isLeader: () => false, start: async () => {}, stop: async () => {} };

    whenLeader(soleLeader, () => ran++)();
    expect(ran).toBe(1); // no Postgres, no peers: identical to the single-process behavior

    whenLeader(follower, () => ran++)();
    expect(ran).toBe(1);
  });
});
