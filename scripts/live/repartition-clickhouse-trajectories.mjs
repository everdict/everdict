// Give an EXISTING ClickHouse trajectory ledger the monthly partition key, by rebuilding the tables.
//
// An unpartitioned MergeTree answers every delete by touching the whole table — `ALTER … DELETE` rewrites
// every part it matches, and a lightweight `DELETE FROM` marks rows across all of them. This is the table
// retention sweeps hourly and the one that grows fastest in the product, so "the whole table" was the standing
// hourly cost. `ClickHouseTrajectoryStore` now declares `PARTITION BY substring(sealed_at, 1, 7)`.
//
// A partition key has no `ALTER`. `CREATE TABLE IF NOT EXISTS` is a no-op on a table that exists, so an
// install created before this change keeps the old layout for ever — which is precisely the fresh-vs-upgraded
// divergence that adapter has been fixed for twice. Boot READS THE LIVE KEY BACK and names this script; this
// is the repair it names.
//
// The shape of it is the point:
//
//   * NOTHING IS DESTROYED UNTIL THE COPY IS COUNTED. Each table is rebuilt as `<name>__repart`, the row
//     counts are compared, and only then are the two swapped with `EXCHANGE TABLES` — one atomic statement,
//     so there is no window where a reader sees a half-built ledger. The old table is left behind as
//     `<name>__old` and is yours to drop once you have looked at it. A repair that deletes the evidence it is
//     repairing is not a repair.
//   * THE SCHEMA COMES FROM THE LIVE TABLE, not from a copy of the DDL in this file. `SHOW CREATE TABLE`
//     already knows every column this deployment has, including ones added by an ALTER; re-spelling the
//     column list here is the drift the one-descriptor rule exists to remove.
//   * IT REFUSES A TABLE THAT IS ALREADY RIGHT, and says so, rather than copying a ledger for nothing.
//   * IT IS NOT SAFE TO RUN WHILE SEALS ARRIVE. `INSERT … SELECT` reads a snapshot; a row sealed after that
//     read and before the exchange lands in the OLD table and is lost by the swap. Stop ingestion, or run it
//     in a window. Stated here rather than implied — this is the one thing that can lose evidence.
//
// Usage:
//   EVERDICT_CLICKHOUSE_URL=http://localhost:8123 node scripts/live/repartition-clickhouse-trajectories.mjs
//   … --database everdict       the ClickHouse database (default: the URL's, else `default`)
//   … --dry-run                 print the statements and the row counts, change nothing
//   … --drop-old                drop `<name>__old` after a verified swap (default: keep it)

const URL_ENV = process.env.EVERDICT_CLICKHOUSE_URL;
if (!URL_ENV) {
  console.error("EVERDICT_CLICKHOUSE_URL is required (e.g. http://localhost:8123)");
  process.exit(1);
}
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const DRY = flag("dry-run");
const DROP_OLD = flag("drop-old");
const DB = value("database", process.env.EVERDICT_CLICKHOUSE_DATABASE ?? "default");
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(DB)) {
  console.error(`--database "${DB}" is not a plain identifier`);
  process.exit(1);
}

// The key the adapter declares. Kept as one string so a reader can diff it against what the server reports.
const PARTITION_BY = "substring(sealed_at, 1, 7)";
const TABLES = ["everdict_trajectories", "everdict_trajectory_events"];

async function run(sql, { read = false } = {}) {
  const url = new URL(URL_ENV);
  url.searchParams.set("query", sql);
  const res = await fetch(url, { method: "POST", body: "" });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 400)}`);
  return read ? text.trim() : undefined;
}

const count = async (table) => Number(await run(`SELECT count() FROM ${DB}.${table}`, { read: true }));

async function repartition(table) {
  const live = await run(
    `SELECT partition_key FROM system.tables WHERE database = '${DB}' AND name = '${table}' FORMAT TabSeparated`,
    { read: true },
  );
  if (live === PARTITION_BY) {
    console.log(`✓ ${DB}.${table} is already partitioned by ${PARTITION_BY} — nothing to do.`);
    return;
  }
  console.log(`▶ ${DB}.${table}: partitioned by \`${live === "" ? "(nothing)" : live}\` → \`${PARTITION_BY}\``);

  // The live DDL is the source of truth for the columns, indexes and ORDER BY. Only the name and the
  // PARTITION BY clause are rewritten — a column list re-spelled here would be a second copy to keep in step.
  const ddl = await run(`SHOW CREATE TABLE ${DB}.${table} FORMAT TabSeparatedRaw`, { read: true });
  if (!/ENGINE\s*=\s*MergeTree/.test(ddl)) throw new Error(`${table} is not a plain MergeTree — rebuild by hand`);
  const renamed = ddl.replace(`${DB}.${table}`, `${DB}.${table}__repart`).replace(/\bCREATE TABLE\b/, "CREATE TABLE");
  const withKey = /PARTITION BY/.test(renamed)
    ? renamed.replace(/PARTITION BY [^\n]*?(?=\s+ORDER BY)/s, `PARTITION BY ${PARTITION_BY}`)
    : renamed.replace(/(ENGINE\s*=\s*MergeTree)/, `$1\nPARTITION BY ${PARTITION_BY}`);

  const before = await count(table);
  if (DRY) {
    console.log(withKey);
    console.log(`  (dry run) would copy ${before} row(s), then EXCHANGE TABLES`);
    return;
  }

  await run(`DROP TABLE IF EXISTS ${DB}.${table}__repart`);
  await run(withKey);
  await run(`INSERT INTO ${DB}.${table}__repart SELECT * FROM ${DB}.${table}`);
  const copied = await count(`${table}__repart`);
  // The count is the only evidence the copy is complete, and it is checked BEFORE the swap — after it there
  // is nothing left to compare against.
  if (copied !== before) {
    throw new Error(
      `${table}: copied ${copied} of ${before} rows — refusing to swap. ` +
        `Something is still writing to the table; stop ingestion and re-run. The copy is left as ${table}__repart.`,
    );
  }
  // One atomic statement, so no reader ever sees a half-built ledger.
  await run(`EXCHANGE TABLES ${DB}.${table} AND ${DB}.${table}__repart`);
  await run(`RENAME TABLE ${DB}.${table}__repart TO ${DB}.${table}__old`);
  console.log(`  swapped: ${copied} row(s) now partitioned. Previous table kept as ${table}__old.`);
  if (DROP_OLD) {
    await run(`DROP TABLE ${DB}.${table}__old`);
    console.log(`  dropped ${table}__old`);
  }
}

try {
  console.log(
    DRY
      ? "▶ dry run — nothing will be changed."
      : "⚠ Stop trace ingestion before running this: a row sealed between the copy and the swap is lost.",
  );
  for (const table of TABLES) await repartition(table);
  console.log("done.");
} catch (err) {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
