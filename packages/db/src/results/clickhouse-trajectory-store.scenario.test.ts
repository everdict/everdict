import type { SealedTrajectory } from "@everdict/application-control";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClickHouseTrajectoryStore } from "./clickhouse-trajectory-store.js";

// Live E2E — the ops-scale trajectory store against a REAL ClickHouse. Requires real infra, so the whole file
// skips when the env is unset (CI-safe). Locally, against the dev stack's ClickHouse:
//   EVERDICT_E2E_CLICKHOUSE_URL=http://172.28.0.7:8123 \
//   pnpm --filter @everdict/db test clickhouse-trajectory-store.scenario
//
// WHY THIS NEEDS A SERVER AND THE FAKE-FETCH SUITE CANNOT DO IT.
//
// The unit suite beside this one serves canned JSONEachRow lines back to the store, so it pins the SQL TEXT
// the store emits and, by construction, can never disagree with the store about what that SQL MEANS. Both
// scenarios below are claims about ClickHouse's own behaviour: whether an `ALTER … ADD COLUMN IF NOT EXISTS`
// actually reaches a table that predates the column (the upgrade path every existing deployment takes), and
// what `argMin(x, sealed_at)` returns when two physically duplicate rows carry SKEWED clocks. A fake that
// replays the row the test author chose answers neither.
const CLICKHOUSE_URL = process.env.EVERDICT_E2E_CLICKHOUSE_URL;
const describeLive = CLICKHOUSE_URL ? describe : describe.skip;

// One scratch database per run, dropped afterwards — the store's own `database()` guard requires a plain
// identifier, and a shared `default` would let two runs read each other's rows.
const DATABASE = `everdict_e2e_${Date.now().toString(36)}`;
const TABLE = `${DATABASE}.everdict_trajectories`;

async function exec(sql: string, body?: string): Promise<string> {
  if (!CLICKHOUSE_URL) throw new Error("EVERDICT_E2E_CLICKHOUSE_URL is unset");
  const url = new URL(CLICKHOUSE_URL);
  url.searchParams.set("query", sql);
  const res = await fetch(url, { method: "POST", body: body ?? "" });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 400)}`);
  return text;
}

const store = (): ClickHouseTrajectoryStore =>
  new ClickHouseTrajectoryStore({ url: CLICKHOUSE_URL ?? "", database: DATABASE });

describeLive("ClickHouseTrajectoryStore against a live server", () => {
  beforeAll(async () => {
    await exec(`CREATE DATABASE IF NOT EXISTS ${DATABASE}`);
  });

  afterAll(async () => {
    await exec(`DROP DATABASE IF EXISTS ${DATABASE}`);
  });

  // ── #13 · THE UPGRADE PATH IS THE ONLY PATH A RUNNING DEPLOYMENT TAKES ──────────────────────────────
  //
  // `schemaSql` is a CREATE TABLE **IF NOT EXISTS**, so on every install that already holds evidence it is a
  // no-op and the additive `ALTER … ADD COLUMN IF NOT EXISTS` statements are the entire migration. A fresh
  // CREATE therefore certifies nothing about what the fleet actually runs: it exercises the one branch no
  // existing deployment takes. HEAD (02a3e15e) added `ADD_ATTEMPT_SQL` for exactly this reason; what was
  // never certified is the ROUND TRIP after the upgrade — that a seal carrying an attempt identity lands in
  // the freshly-ALTERed column and reads back as the same identity.
  describe("a table created before attempt identity existed, upgraded in place", () => {
    it("seals and returns the exact attempt identity after ensureSchema ALTERs the old table", async () => {
      // Given a table created by an OLDER release — no attempt_id, no preview, no label/kind: the shape a
      // deployment that has been holding evidence since the multi-plane rung still has on disk.
      await exec(`DROP TABLE IF EXISTS ${TABLE}`);
      await exec(`CREATE TABLE ${TABLE} (
        run_id String,
        tenant String,
        source String,
        emitter String DEFAULT '',
        event_count UInt32,
        body String,
        t0 String DEFAULT '',
        sealed_at String,
        owner String DEFAULT '',
        body_format String DEFAULT '',
        INDEX idx_run run_id TYPE bloom_filter GRANULARITY 4
      ) ENGINE = MergeTree ORDER BY (tenant, sealed_at, run_id)`);

      // When the new release boots over it
      const ch = store();
      await ch.ensureSchema();

      // …and seals evidence naming the physical attempt that produced it
      const sealed = await ch.seal({
        runId: "run-upgrade-1",
        tenant: "acme",
        source: "run",
        events: [{ t: 0, kind: "llm_call", model: "m" }],
        attemptId: "exec-7#g2",
      });
      expect(sealed.created).toBe(true);

      // Then the read hands back the SAME attempt, not the empty default the pre-upgrade column would give.
      // An upgraded install that silently drops the identity is indistinguishable from a producer that never
      // declared one — and "the producer did not say" is the reading the store documents for ''.
      const read = await ch.get("acme", "run-upgrade-1");
      expect(read?.segments[0]?.attemptId).toBe("exec-7#g2");
    });
  });

  // ── #14 · A CANONICAL READER ASKS FOR AN IDENTITY, NOT FOR THE EARLIEST CLOCK ───────────────────────
  //
  // MergeTree has no unique key, so this store resolves duplicates at READ with `argMin(…, sealed_at)` —
  // first-write-wins, decided by a STRING clock each writer stamps from its own `new Date()`. Two properties
  // of that arrangement collide:
  //
  //   1. `sealed_at` is the writer's local clock. Skew between two control-plane replicas is ordinary, and
  //      nothing validates that a later INSERT carries a later timestamp.
  //   2. WHICH attempt's evidence a case's verdict rests on is already decided elsewhere, in Postgres, by the
  //      commit receipt (`CaseCommitReceipt` → the attempt identity the trajectory seal stamps).
  //
  // So the ledger selects an identity and the evidence store answers a different question — "whose clock was
  // smallest" — and when a duplicate seal arrives with a backdated stamp the reader silently serves the OTHER
  // attempt's bytes under the run the receipt named. Every digest downstream agrees, because each half is
  // internally consistent; only the join between them is wrong.
  //
  // The read this pins is therefore `get(tenant, runId, { attemptId })`: once the receipt has selected the
  // canonical identity, a reader must be able to ASK for it. Expressed against the store's public surface
  // through the shape wave 7 delivers, because the current signature has no way to say it.
  describe("concurrent duplicate seals with a skewed clock", () => {
    // [WAVE-7 COUNTEREXAMPLE #14] RED as of 02a3e15e: `AssertionError: expected 'exec-EARLY#g1' to be
    // 'exec-LATE#g2'` — `get` resolves every column with `argMin(col, sealed_at)` regardless of which attempt
    // the caller asked for, and it accepts no attempt argument at all, so the backdated duplicate wins and the
    // receipt-selected identity is unreachable. Un-skip when wave 7 lands.
    it.skip("serves the attempt the receipt selected, not the row whose clock happened to be smallest", async () => {
      // Given one (run, emitter) with two physically duplicate rows: the SECOND writer's clock is BEHIND the
      // first's, which is what replica skew looks like on the wire.
      await exec(`DROP TABLE IF EXISTS ${TABLE}`);
      const ch = store();
      await ch.ensureSchema();
      const row = (attemptId: string, sealedAt: string, marker: string): string =>
        JSON.stringify({
          run_id: "run-skew-1",
          tenant: "acme",
          source: "run",
          emitter: "run",
          event_count: 1,
          body: JSON.stringify([{ t: 0, kind: "message", role: "assistant", text: marker }]),
          body_format: "events",
          t0: "",
          sealed_at: sealedAt,
          owner: "",
          kind: "",
          label: "",
          preview: "",
          attempt_id: attemptId,
        });
      // The attempt the ledger will NOT select, written first and stamped later…
      await exec(
        `INSERT INTO ${TABLE} FORMAT JSONEachRow`,
        `${row("exec-LATE#g2", "2026-08-15T00:00:10.000Z", "from the committed attempt")}\n`,
      );
      // …and the duplicate whose replica clock is behind, so argMin picks it.
      await exec(
        `INSERT INTO ${TABLE} FORMAT JSONEachRow`,
        `${row("exec-EARLY#g1", "2026-08-15T00:00:00.000Z", "from the abandoned attempt")}\n`,
      );

      // When a reader asks BY THE IDENTITY THE PG RECEIPT COMMITTED — the future read wave 7 introduces.
      interface AttemptScopedReader {
        get(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined>;
      }
      const reader = ch as unknown as AttemptScopedReader;
      const read = await reader.get("acme", "run-skew-1", { attemptId: "exec-LATE#g2" });

      // Then it gets that attempt's bytes. A reader that asked for one execution's evidence and was handed
      // another's has no way to notice: both rows are well-formed evidence of the same run id.
      expect(read?.segments[0]?.attemptId).toBe("exec-LATE#g2");
      expect(read?.events[0]).toMatchObject({ text: "from the committed attempt" });
    });
  });
});
