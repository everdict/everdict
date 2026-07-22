// Live verification: PgRecordingStore persists a replay recording in real Postgres — proves the SQL the
// fake-SqlClient unit test can only assert-the-text of actually WORKS: the row-locked jsonb_set append, the
// seal derivation (t0 + effectiveFidelity from the accumulated tracks), and the sealed get round-trip (still
// readable through a fresh pool = a process restart).
//
//  1) preflight → migrate (create everdict_recordings via 0063, idempotent)
//  2) PgRecordingStore: append(frames×2 + logs×1) → get(unsealed→undefined) → seal → get → assert
//  3) re-read with a fresh pool (process-restart simulation) → proves durability
//
// Usage: DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5434/postgres node scripts/live/pg-recording-store.mjs

import { PgRecordingStore, makePool, migrate, preflight, sqlClient } from "../../packages/db/dist/index.js";

const URL = process.env.DATABASE_URL;
if (!URL) throw new Error("DATABASE_URL required — credentials via env only (no default committed to git)");
const RUN_ID = `pglive-rec-${Date.now().toString(36)}`;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const pool = makePool(URL);
  const client = sqlClient(pool);

  console.log("=== (1) preflight + migrate ===");
  console.log("  preflight 0063:", await preflight(client, "0063_create_recordings.sql"));
  const { applied } = await migrate(client);
  console.log("  migrate applied:", applied.length ? applied.join(", ") : "(none — already applied)");

  console.log("\n=== (2) PgRecordingStore lifecycle ===");
  const store = new PgRecordingStore(client);
  // Append two frames + a log (as the runner tees them during a run) — note the frames arrive out of t order.
  await store.append(RUN_ID, { track: "frames", entry: { t: 2000, ref: "s3://f2", hash: "h2" } });
  await store.append(RUN_ID, { track: "logs", entry: { t: 1500, stream: "stdout", text: "step 1" } });
  await store.append(RUN_ID, { track: "frames", entry: { t: 1000, ref: "s3://f1", hash: "h1" } });
  console.log("  appended 2 frames + 1 log (row-locked jsonb_set append)");

  assert((await store.get(RUN_ID)) === undefined, "an unsealed recording is not retrievable");

  const ref = await store.seal(RUN_ID, { envKind: "browser", dispatch: { harness: "browser-use@1" } });
  assert(ref?.ref === `pg://recording/${RUN_ID}`, "seal returns a pg:// ref");

  const rec = await store.get(RUN_ID);
  assert(rec !== undefined, "the sealed recording is retrievable");
  assert(rec.t0 === 1000, `t0 derived as the earliest event across lanes (got ${rec?.t0})`);
  assert(rec.envKind === "browser", "envKind persisted");
  assert(rec.effectiveFidelity === "frames", "effectiveFidelity derived as frames (a frame series present)");
  assert(rec.tracks.frames?.length === 2, `both frames persisted (got ${rec?.tracks.frames?.length})`);
  assert(rec.tracks.logs?.length === 1, "the log lane persisted");
  assert(rec.dispatch?.harness === "browser-use@1", "the dispatch manifest sealed");
  assert(
    rec.tracks.frames?.map((f) => f.ref).join(",") === "s3://f2,s3://f1",
    "append order within a lane is preserved",
  );

  console.log("\n=== (3) fresh pool (process-restart simulation) ===");
  const pool2 = makePool(URL);
  const store2 = new PgRecordingStore(sqlClient(pool2));
  const again = await store2.get(RUN_ID);
  assert(again?.t0 === 1000 && again?.tracks.frames?.length === 2, "the recording survives a fresh connection");
  await pool2.end();

  await client.query("DELETE FROM everdict_recordings WHERE run_id = $1", [RUN_ID]);
  await pool.end();
  console.log("\n✅ PgRecordingStore live round-trip PASS");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
