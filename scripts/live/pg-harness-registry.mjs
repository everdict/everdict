// Live verification: persist the harness version SSOT in real Postgres.
//
//  1) migrate (create everdict_harnesses, 0001+0002 idempotent)
//  2) seed file SSOT (examples/harnesses) → PgHarnessRegistry (loadHarnessDir(into=pg))
//  3) versions/getService(latest) + immutability (re-register a different spec → 409 Conflict)
//  4) resolve the same spec with a fresh pool (simulating a process restart) → proves persistence
//
// Usage: DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/postgres node scripts/live/pg-harness-registry.mjs

import { makePool, migrate, sqlClient } from "../../packages/db/dist/index.js";
import {
  PgHarnessInstanceRegistry,
  PgHarnessTemplateRegistry,
  loadHarnessTaxonomyDir,
} from "../../packages/registry/dist/index.js";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL required — credentials via env only (no default committed to git)");
const DIR = new URL("../../examples/harness-templates", import.meta.url).pathname;
const T = "_shared";

async function main() {
  const pool = makePool(DB_URL);
  const client = sqlClient(pool);

  console.log("=== (1) migrate ===");
  const { applied } = await migrate(client);
  console.log("  applied:", applied.length ? applied.join(", ") : "(none — already applied)");

  console.log("\n=== (2) seed taxonomy(file SSOT: templates + instances) → Postgres ===");
  const templates = new PgHarnessTemplateRegistry(client);
  const instances = new PgHarnessInstanceRegistry(client, templates);
  await loadHarnessTaxonomyDir(DIR, { templates, instances }); // register files into PG (idempotent)
  for (const { id, versions } of await instances.list(T)) console.log(`  ${id}: ${versions.join(", ")}`);

  console.log("\n=== (3) resolve + immutability ===");
  const latest = await instances.getService(T, "bu", "latest");
  console.log(
    `  bu@latest → ${latest.id}@${latest.version} (deps: ${latest.dependencies.map((d) => d.store).join("+")})`,
  );
  const inst = await instances.getInstance(T, "bu", "latest");
  let conflict = false;
  try {
    await instances.register(T, { ...inst, pins: { "agent-server": "different:tag" } });
  } catch (e) {
    conflict = e.code === "CONFLICT";
    console.log(`  re-register bu@${inst.version} with different pins → ${e.code} (immutable ✓)`);
  }

  console.log("\n=== (4) fresh pool (process-restart) → still there ===");
  await pool.end();
  const pool2 = makePool(DB_URL);
  const client2 = sqlClient(pool2);
  const templates2 = new PgHarnessTemplateRegistry(client2);
  const instances2 = new PgHarnessInstanceRegistry(client2, templates2);
  const reread = await instances2.get(T, "bu", inst.version);
  console.log(`  re-read bu@${inst.version} after reconnect → ${reread.id}@${reread.version}`);
  const ok = reread.version === inst.version && conflict;
  console.log(ok ? "✅ harness taxonomy persisted in Postgres (immutable, survives reconnect)" : "❌ unexpected");

  // Clean up: delete the demo rows (keep tables/migrations).
  await client2.query("DELETE FROM everdict_harness_instances WHERE id = $1", ["bu"]);
  await client2.query("DELETE FROM everdict_harness_templates WHERE id = $1", ["bu"]);
  await pool2.end();
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
