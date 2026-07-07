import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./client.js";

export interface Migration {
  name: string;
  sql: string;
}

export type PreflightVerdict = "OK_TO_APPLY" | "ALREADY_APPLIED" | "BLOCKED";

const TRACK = "everdict_schema_migrations";

// migrations 디렉터리에서 정렬된 .sql 파일을 읽는다. 기본 경로는 packages/db/migrations.
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

// 읽기 전용 preflight: 적용 여부를 알린다(OK_TO_APPLY / ALREADY_APPLIED). 호출 전 트래킹 테이블 보장.
export async function preflight(client: SqlClient, name: string): Promise<PreflightVerdict> {
  await ensureTracking(client);
  return (await isApplied(client, name)) ? "ALREADY_APPLIED" : "OK_TO_APPLY";
}

// 미적용 마이그레이션을 순서대로 적용하고 트래킹 테이블에 기록. 적용된 이름 목록을 돌려준다.
// 0001(create_runs)은 additive 라 deploy 와 함께 안전하게 적용된다.
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
