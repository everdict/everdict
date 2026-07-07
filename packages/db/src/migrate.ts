import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./client.js";

export interface Migration {
  name: string;
  sql: string;
}

export type PreflightVerdict = "OK_TO_APPLY" | "ALREADY_APPLIED" | "BLOCKED";

const TRACK = "everdict_schema_migrations";

// Reads sorted .sql files from the migrations directory. The default path is packages/db/migrations.
export function readMigrations(dir?: string): Migration[] {
  const path = dir ?? fileURLToPath(new URL("../migrations/", import.meta.url));
  return readdirSync(path)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(`${path.replace(/\/$/, "")}/${f}`, "utf8") }));
}

async function ensureTracking(client: SqlClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${TRACK} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
}

async function isApplied(client: SqlClient, name: string): Promise<boolean> {
  const res = await client.query<{ name: string }>(`SELECT name FROM ${TRACK} WHERE name = $1`, [name]);
  return res.rows.length > 0;
}

// Read-only preflight: reports whether it's applied (OK_TO_APPLY / ALREADY_APPLIED). Ensures the tracking table before the check.
export async function preflight(client: SqlClient, name: string): Promise<PreflightVerdict> {
  await ensureTracking(client);
  return (await isApplied(client, name)) ? "ALREADY_APPLIED" : "OK_TO_APPLY";
}

// Applies un-applied migrations in order and records them in the tracking table. Returns the list of applied names.
// 0001 (create_runs) is additive, so it applies safely alongside the deploy.
export async function migrate(
  client: SqlClient,
  opts: { migrations?: Migration[]; dir?: string } = {},
): Promise<{ applied: string[] }> {
  await ensureTracking(client);
  const migrations = opts.migrations ?? readMigrations(opts.dir);
  const applied: string[] = [];
  for (const m of migrations) {
    if (await isApplied(client, m.name)) continue; // ALREADY_APPLIED
    await client.query(m.sql);
    await client.query(`INSERT INTO ${TRACK} (name) VALUES ($1)`, [m.name]);
    applied.push(m.name);
  }
  return { applied };
}
