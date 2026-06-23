// 라이브 검증: 하니스 버전 SSOT 를 실제 Postgres 에 영속한다.
//
//  1) migrate (assay_harnesses 생성, 0001+0002 멱등)
//  2) 파일 SSOT(examples/harnesses) → PgHarnessRegistry 로 시드(loadHarnessDir(into=pg))
//  3) versions/getService(latest) + 불변성(다른 스펙 재등록 → 409 Conflict)
//  4) 새 풀(프로세스 재기동 모사)로 같은 스펙 조회 → 영속 증명
//
// 사용: DATABASE_URL=postgresql://ho2eny:PASS@127.0.0.1:55433/postgres node scripts/live/pg-harness-registry.mjs

import { makePool, migrate, sqlClient } from "../../packages/db/dist/index.js";
import {
  PgHarnessInstanceRegistry,
  PgHarnessTemplateRegistry,
  loadHarnessTaxonomyDir,
} from "../../packages/registry/dist/index.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://ho2eny:zBQzo4rXyTKHXcdfu9Dc@127.0.0.1:55433/postgres";
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
  await loadHarnessTaxonomyDir(DIR, { templates, instances }); // 파일을 PG 에 등록(멱등)
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

  // 정리: 데모 row 삭제(테이블/마이그레이션 유지).
  await client2.query("DELETE FROM assay_harness_instances WHERE id = $1", ["bu"]);
  await client2.query("DELETE FROM assay_harness_templates WHERE id = $1", ["bu"]);
  await pool2.end();
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
