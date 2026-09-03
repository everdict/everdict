import { PgWorldCreationStore, type SqlClient } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-193.
//
// EXACTLY ONE CASE IS TOLD TO BUILD THE WORLD, AND THE DATABASE IS WHAT DECIDES IT.
//
// A `per-run` world (docs/architecture/world-and-engagement-model.md, 3.95) stands up once and the batch's
// cases take turns in it. The whole election is `acquireShared`'s single statement, and every part of it is a
// claim only a real engine can answer:
//
//   ① THE ARBITER IS A PARTIAL UNIQUE INDEX. `ON CONFLICT (tenant, shared_key) WHERE shared_key IS NOT NULL
//      AND state <> 'released'` has to be INFERRED by Postgres against migration 0209's index. An inference
//      that does not match is not a subtle bug — the statement does not run at all, and no in-memory twin and
//      no fake `SqlClient` asserting on query TEXT can see it.
//   ② `xmax = 0` IS HOW THE WINNER LEARNS IT WON. It is the row-level answer to "did my INSERT insert", and
//      it exists only inside a real MVCC snapshot. A twin returns whatever its author decided.
//   ③ THE RELEASED ROW LEAVES THE INDEX. The predicate is what makes a torn-down world's NAME free, so the
//      next batch inserts a new world instead of joining a settled row and being handed the coordinates of a
//      world that is gone.
//
// The in-memory twin models all three and is the thing under suspicion, not the evidence: it is a hand-written
// map that cannot conflict, cannot expose `xmax`, and has no index at all.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

const SERVICES = [{ name: "web", image: "shop:1", port: 8080 }];

describeTrust("TRUST-193 — one conditional write elects the case that builds a shared world", () => {
  let pg: TrustPg;
  let store: PgWorldCreationStore;
  let client: SqlClient;
  const tenants: string[] = [];

  beforeAll(async () => {
    pg = await openTrustPg();
    client = pg.client;
    store = new PgWorldCreationStore(client);
  });
  afterAll(async () => {
    if (tenants.length > 0)
      await client.query("DELETE FROM everdict_created_worlds WHERE tenant = ANY($1::text[])", [tenants]);
    await pg.close();
  });

  const acquire = (tenant: string, key: string, over: { id?: string; runId?: string; expiresAt?: string } = {}) =>
    store.acquireShared({
      id: over.id ?? trustId("cw"),
      tenant,
      runId: over.runId ?? trustId("run"),
      environment: "shop@1.0.0",
      sharedKey: key,
      services: SERVICES,
      expiresAt: over.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
      now: new Date().toISOString(),
    });

  it("① two cases racing for one world get two different answers, and only one of them creates", async () => {
    const tenant = trustId("tenant");
    tenants.push(tenant);
    const key = `${trustId("batch")}|shop@1.0.0|-`;
    // Both statements in flight at once, against the same index. The database arbitrates; nothing here does.
    const [a, b] = await Promise.all([acquire(tenant, key), acquire(tenant, key)]);
    expect([a.created, b.created].filter(Boolean), "two builders is two worlds and one row").toHaveLength(1);
    expect(a.row.id).toBe(b.row.id);
    const row = await store.getShared(tenant, key);
    expect(row?.holders, "both cases are inside it").toBe(2);
  });

  it("② the endpoints the creator recorded are what a joiner reads back — not a second answer", async () => {
    const tenant = trustId("tenant");
    tenants.push(tenant);
    const key = `${trustId("batch")}|shop@1.0.0|-`;
    const first = await acquire(tenant, key);
    expect(first.created).toBe(true);
    expect(await store.transition(tenant, first.row.id, "created", { endpoints: { web: "http://web:8080" } })).toBe(
      true,
    );
    const joiner = await acquire(tenant, key);
    expect(joiner.created).toBe(false);
    expect(joiner.row.state).toBe("created");
    expect(joiner.row.endpoints).toEqual({ web: "http://web:8080" });
  });

  it("③ a RELEASED world's name is free: the next batch inserts a new world, never joins the settled row", async () => {
    const tenant = trustId("tenant");
    tenants.push(tenant);
    const key = `${trustId("batch")}|shop@1.0.0|-`;
    const first = await acquire(tenant, key);
    await store.transition(tenant, first.row.id, "created", { endpoints: { web: "http://gone:8080" } });
    await store.releaseShared(tenant, key);
    await store.transition(tenant, first.row.id, "released");

    const again = await acquire(tenant, key);
    expect(again.created, "somebody has to build the new world").toBe(true);
    expect(again.row.id, "joining a released row hands a case the coordinates of a world that is gone").not.toBe(
      first.row.id,
    );
    expect(again.row.endpoints).toBeUndefined();
    // …and the settled row is still there, still released: history, not a candidate.
    expect((await store.get(tenant, first.row.id))?.state).toBe("released");
  });

  it("④ another workspace's identical key is another world — the index is per tenant", async () => {
    const key = `${trustId("batch")}|shop@1.0.0|-`;
    const mine = trustId("tenant");
    const theirs = trustId("tenant");
    tenants.push(mine, theirs);
    const a = await acquire(mine, key);
    const b = await acquire(theirs, key);
    expect(a.created && b.created, "two workspaces meeting in one world is the worst a shared key can do").toBe(true);
    expect(a.row.id).not.toBe(b.row.id);
  });

  it("⑤ the reaper's worklist: a world with a holder is not owed, an expired lease is, and an idle one is", async () => {
    const tenant = trustId("tenant");
    tenants.push(tenant);
    const key = `${trustId("batch")}|shop@1.0.0|-`;
    // A long lease on purpose: this row is here to test the HOLDER guard, and a short lease would take it
    // through the other arm before the holder question is ever asked.
    const held = await acquire(tenant, key, { expiresAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString() });
    await store.transition(tenant, held.row.id, "created", { endpoints: { web: "http://web:8080" } });
    const owedNow = async (now: string, staleMs: number) =>
      (await store.due(now, staleMs)).filter((r) => r.tenant === tenant).map((r) => r.id);

    const now = new Date().toISOString();
    const later = new Date(Date.parse(now) + 60 * 60_000).toISOString();
    expect(await owedNow(now, 15 * 60_000), "a world somebody is inside is never owed").toEqual([]);
    // THE DISCRIMINATING CASE: an hour on, the row is idle by every clock the sweep reads and a case is still
    // inside it. Staleness alone would sweep a world a live agent is acting in, and the score would come back
    // looking like an ordinary failure — so the holder count is the only thing keeping it out here.
    expect(await owedNow(later, 15 * 60_000), "the holder is the fence, not the clock").toEqual([]);

    // Nobody inside, but only just — an empty world is not yet an idle one.
    await store.releaseShared(tenant, key);
    expect(await owedNow(now, 15 * 60_000)).toEqual([]);
    // …and an hour on, with nobody having come back, it is.
    expect(await owedNow(later, 15 * 60_000)).toEqual([held.row.id]);

    // The lease is the other half: a crashed holder never leaves, so its count alone would pin the world.
    const key2 = `${trustId("batch")}|shop@1.0.0|-`;
    const crashed = await acquire(tenant, key2, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await store.transition(tenant, crashed.row.id, "created", { endpoints: { web: "http://web:8080" } });
    expect((await store.getShared(tenant, key2))?.holders, "the holder is recorded and gone").toBe(1);
    expect(await owedNow(now, 15 * 60_000)).toContain(crashed.row.id);
  });
});
