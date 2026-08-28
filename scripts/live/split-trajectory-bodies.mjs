// Split trajectory planes sealed before mig 0200 into one row per event, so a windowed read can serve them.
//
// A plane written before the split is one jsonb blob, and there is no window of a blob that costs less than
// the whole blob — so `TrajectoryStore.events` REFUSES those above its ceiling (`too_large`) rather than
// materializing them and taking the process with it. This is how that refusal converges.
//
// The shape of it is the point:
//
//   * ONE DERIVATION. The seq order for a spans plane is `sortSpansForProjection`, and the batch facts are
//     `spanBatchFacts` — both imported from the built domain package, never re-spelled here. The store pages
//     by row position while the projection sorts by `startedAt`, so a hand-rolled ordering would hand back a
//     permuted stream; and a hand-rolled `baseMs`/`perCallTokens` would make a paged read disagree with a
//     whole one about `t` and about llm_call counts (rule `protocol` L3).
//   * ONE PLANE AT A TIME, smallest first, with a ceiling. The bodies this repays are exactly the ones that
//     caused the OOM, so a plane is read only when its stored body is under --max-bytes (default 64 MiB) and
//     the rest are REPORTED by id. A plane it skipped keeps answering `too_large`, which is true.
//   * NOTHING IS DESTROYED. `body` is left exactly as it was; only `body_split`, `batch` and the new event
//     rows are written. That is the expand half of expand → deploy → contract: the blob is redundant after
//     this runs, and reclaiming it is a separate decision with its own migration, taken once the split rows
//     have been read in anger. A repair that deletes the only copy of the evidence it is repairing is not a
//     repair.
//   * IDEMPOTENT. `WHERE body_split = false` selects the work and the event rows go in with
//     `ON CONFLICT DO NOTHING`, so a re-run after a crash finishes the job instead of doubling it.
//
// Usage:
//   DATABASE_URL=postgresql://USER:PASS@HOST:5432/db node scripts/live/split-trajectory-bodies.mjs
//   … --max-bytes 134217728     raise the per-plane ceiling (the process heap is the real limit)
//   … --limit 50                stop after N planes (resumable — the WHERE clause is the cursor)
//   … --dry-run                 report what would be written, write nothing

import { makePool, sqlClient } from "../../packages/db/dist/index.js";
import { sortSpansForProjection, spanBatchFacts } from "../../packages/domain/dist/index.js";

const URL = process.env.DATABASE_URL;
if (!URL) throw new Error("DATABASE_URL required — credentials via env only (no default committed to git)");

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}
const MAX_BYTES = flag("--max-bytes", 64 * 1024 * 1024);
const LIMIT = flag("--limit", Number.POSITIVE_INFINITY);
const DRY = process.argv.includes("--dry-run");

const TABLES = [
  { name: "everdict_trajectories", where: "run_id = $1", key: (row) => [row.run_id] },
  {
    name: "everdict_trajectory_segments",
    where: "run_id = $1 AND emitter = $2",
    key: (row) => [row.run_id, row.emitter],
  },
];

async function split(client, table, report) {
  // pg_column_size reads the STORED (toasted, compressed) size — no detoast, which is the only way to ask
  // "is this too big to read" without reading it. It UNDER-reports the in-memory footprint, so --max-bytes is
  // a conservative bound rather than a guarantee; lower it if the process dies.
  const { rows: candidates } = await client.query(
    `SELECT run_id, ${table.name === "everdict_trajectories" ? "COALESCE(emitter, source) AS emitter" : "emitter"},
            body_format, pg_column_size(body) AS stored_bytes
       FROM ${table.name}
      WHERE body_split = false
      ORDER BY stored_bytes ASC`,
  );
  for (const candidate of candidates) {
    if (report.split + report.skipped >= LIMIT) return;
    const at = `${table.name}:${candidate.run_id}/${candidate.emitter}`;
    if (Number(candidate.stored_bytes) > MAX_BYTES) {
      report.skipped += 1;
      report.tooLarge.push(`${at} (${candidate.stored_bytes} stored bytes)`);
      continue;
    }
    const key = table.key(candidate);
    const { rows } = await client.query(`SELECT body FROM ${table.name} WHERE ${table.where}`, key);
    const body = rows[0]?.body;
    if (!Array.isArray(body)) {
      report.skipped += 1;
      report.unreadable.push(`${at} (body is not an array)`);
      continue;
    }
    // A spans plane is stored in PROJECTION order and carries the facts a page needs; an events plane is
    // stored as it arrived and has neither.
    const spans = candidate.body_format === "spans";
    const items = spans ? sortSpansForProjection(body) : body;
    const batch = spans ? JSON.stringify(spanBatchFacts(items)) : null;
    if (!DRY) {
      await client.query(
        `INSERT INTO everdict_trajectory_events (run_id, emitter, seq, body, bytes)
         SELECT $1, $2, ordinality, value, (bytes_in.value)::int
           FROM unnest($3::jsonb[]) WITH ORDINALITY AS body_in(value, ordinality)
           JOIN unnest($4::int[]) WITH ORDINALITY AS bytes_in(value, ordinality) USING (ordinality)
         ON CONFLICT (run_id, emitter, seq) DO NOTHING`,
        [
          candidate.run_id,
          candidate.emitter,
          items.map((item) => JSON.stringify(item)),
          items.map((item) => JSON.stringify(item).length),
        ],
      );
      // The flag LAST, and conditional on itself: until it flips, the plane still reads from `body`, so a
      // crash between the two statements leaves a readable plane with some event rows nobody points at —
      // which the next run finishes. The other order would publish a split plane whose rows are not all
      // there yet, and every read would serve a short trace.
      await client.query(
        `UPDATE ${table.name} SET body_split = true, batch = $${key.length + 1}
          WHERE ${table.where} AND body_split = false`,
        [...key, batch],
      );
    }
    report.split += 1;
  }
}

async function main() {
  const pool = makePool(URL);
  const client = sqlClient(pool);
  const report = { split: 0, skipped: 0, tooLarge: [], unreadable: [] };
  try {
    for (const table of TABLES) await split(client, table, report);
  } finally {
    await pool.end();
  }
  console.log(`${DRY ? "[dry-run] " : ""}split ${report.split} plane(s) into event rows`);
  // The planes still owed are NAMED. A repair that reported only its successes would read as "every plane is
  // readable now", which is the silent-truncation shape rule `ci` refuses in the gates.
  if (report.tooLarge.length > 0)
    console.log(`still unsplit — body over --max-bytes ${MAX_BYTES}:\n  ${report.tooLarge.join("\n  ")}`);
  if (report.unreadable.length > 0)
    console.log(`still unsplit — body could not be read:\n  ${report.unreadable.join("\n  ")}`);
  if (report.skipped > 0) process.exitCode = 1; // an incomplete repair is not a green run
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
