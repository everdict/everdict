// Backfill the seal-time usage summary onto trajectories sealed before mig 0199 existed.
//
// Those rows read as `unknown` — deliberately, because a row whose cost nobody derived is not a row that
// cost nothing and the number ends up on an invoice. This is how the debt is repaid, and the shape of it is
// the point:
//
//   * ONE derivation. `usageFromTrace` is imported from the built domain package, never re-spelled in SQL.
//     A SQL backfill would have been the same predicate in a second language over evidence that is never
//     rewritten — and a predicate written twice has already diverged (rule `protocol` L3).
//   * ONE ROW AT A TIME, smallest first, with a ceiling. The bodies this repays are exactly the ones that
//     caused the OOM, so a row is read only when its stored body is under --max-bytes (default 64 MiB) and
//     the rest are REPORTED by id rather than guessed for. "We could not find out" is an escalation field,
//     never a terminal state (L5) — a skipped row keeps saying `unknown`, which is true.
//   * NEVER overwrites. `WHERE usage IS NULL` on both tables: a summary derived at seal is the record, and
//     this script is a repair, not a second writer.
//
// Usage:
//   DATABASE_URL=postgresql://USER:PASS@HOST:5432/db node scripts/live/backfill-trajectory-usage.mjs
//   … --max-bytes 134217728     raise the per-row ceiling (the process heap is the real limit)
//   … --limit 500               stop after N rows (resumable — the WHERE clause is the cursor)
//   … --dry-run                 report what would be written, write nothing

import { makePool, sqlClient } from "../../packages/db/dist/index.js";
import { spansToEvents, usageFromTrace } from "../../packages/domain/dist/index.js";

const URL = process.env.DATABASE_URL;
if (!URL) throw new Error("DATABASE_URL required — credentials via env only (no default committed to git)");

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}
const MAX_BYTES = flag("--max-bytes", 64 * 1024 * 1024);
const LIMIT = flag("--limit", Number.POSITIVE_INFINITY);
const DRY = process.argv.includes("--dry-run");

// The header table is keyed by run_id alone; a side plane is keyed by (run_id, emitter). One shape, two
// tables, so the SELECT that reads a body and the UPDATE that repays it address exactly one row on both.
const TABLES = [
  { name: "everdict_trajectories", where: "run_id = $1", key: (row) => [row.run_id] },
  {
    name: "everdict_trajectory_segments",
    where: "run_id = $1 AND emitter = $2",
    key: (row) => [row.run_id, row.emitter],
  },
];

async function backfill(client, table, report) {
  // pg_column_size is the STORED (toasted, compressed) size — cheap, no detoast, and the only size question
  // answerable without paying the very cost this ceiling exists to avoid. It UNDER-reports the in-memory
  // footprint, so --max-bytes is a conservative bound rather than a guarantee; lower it if the process dies.
  const { rows: candidates } = await client.query(
    `SELECT run_id, ${table.name === "everdict_trajectories" ? "'' AS emitter" : "emitter"},
            pg_column_size(body) AS stored_bytes
       FROM ${table.name}
      WHERE usage IS NULL
      ORDER BY stored_bytes ASC`,
  );
  for (const candidate of candidates) {
    if (report.written + report.skipped >= LIMIT) return;
    const at = `${table.name}:${candidate.run_id}${candidate.emitter ? `/${candidate.emitter}` : ""}`;
    if (Number(candidate.stored_bytes) > MAX_BYTES) {
      report.skipped += 1;
      report.tooLarge.push(`${at} (${candidate.stored_bytes} stored bytes)`);
      continue;
    }
    // Read exactly one body, derive, write, drop it. Two rows are never held at once.
    const key = table.key(candidate);
    const { rows } = await client.query(`SELECT body, body_format FROM ${table.name} WHERE ${table.where}`, key);
    const row = rows[0];
    if (!row) continue; // deleted by retention between the two reads — nothing owed
    let usage;
    try {
      usage = row.body_format === "spans" ? usageFromTrace(spansToEvents(row.body)) : usageFromTrace(row.body);
    } catch (err) {
      // A body that will not project stays `unknown`, exactly as a seal that could not derive one leaves it.
      report.skipped += 1;
      report.unprojectable.push(`${at} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!DRY)
      // `AND usage IS NULL` so a seal that landed between the two reads is never overwritten by this repair.
      await client.query(`UPDATE ${table.name} SET usage = $${key.length + 1} WHERE ${table.where} AND usage IS NULL`, [
        ...key,
        JSON.stringify(usage),
      ]);
    report.written += 1;
  }
}

async function main() {
  const pool = makePool(URL);
  const client = sqlClient(pool);
  const report = { written: 0, skipped: 0, tooLarge: [], unprojectable: [] };
  try {
    for (const table of TABLES) await backfill(client, table, report);
  } finally {
    await pool.end();
  }
  console.log(`${DRY ? "[dry-run] " : ""}usage backfilled onto ${report.written} row(s)`);
  // The rows still owed are NAMED. A backfill that reported only its successes would read as "every row is
  // repaid now", which is the silent-truncation shape rule `ci` refuses in the gates.
  if (report.tooLarge.length > 0)
    console.log(`still unknown — body over --max-bytes ${MAX_BYTES}:\n  ${report.tooLarge.join("\n  ")}`);
  if (report.unprojectable.length > 0)
    console.log(`still unknown — body would not project:\n  ${report.unprojectable.join("\n  ")}`);
  if (report.skipped > 0) process.exitCode = 1; // an incomplete repair is not a green run
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
