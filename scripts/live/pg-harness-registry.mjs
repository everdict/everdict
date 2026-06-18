// 라이브 검증: 하니스 버전 SSOT 를 실제 Postgres 에 영속한다.
//
//  1) migrate (assay_harnesses 생성, 0001+0002 멱등)
//  2) 파일 SSOT(examples/harnesses) → PgHarnessRegistry 로 시드(loadHarnessDir(into=pg))
//  3) versions/getService(latest) + 불변성(다른 스펙 재등록 → 409 Conflict)
//  4) 새 풀(프로세스 재기동 모사)로 같은 스펙 조회 → 영속 증명
//
// 사용: DATABASE_URL=postgresql://ho2eny:PASS@127.0.0.1:55433/postgres node scripts/live/pg-harness-registry.mjs

import { makePool, migrate, sqlClient } from "../../packages/db/dist/index.js";
import { PgHarnessRegistry, loadHarnessDir } from "../../packages/registry/dist/index.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://ho2eny:zBQzo4rXyTKHXcdfu9Dc@127.0.0.1:55433/postgres";
const DIR = new URL("../../examples/harnesses", import.meta.url).pathname;

async function main() {
  const pool = makePool(DB_URL);
  const client = sqlClient(pool);

  console.log("=== (1) migrate ===");
  const { applied } = await migrate(client);
  console.log("  applied:", applied.length ? applied.join(", ") : "(none — already applied)");

  console.log("\n=== (2) seed file SSOT → Postgres ===");
  const reg = new PgHarnessRegistry(client);
  await loadHarnessDir(DIR, reg); // 파일을 PG 에 등록(멱등)
  for (const { id, versions } of await reg.list()) console.log(`  ${id}: ${versions.join(", ")}`);

  console.log("\n=== (3) resolve + immutability ===");
  const latest = await reg.getService("bu", "latest");
  console.log(
    `  bu@latest → ${latest.id}@${latest.version} (deps: ${latest.dependencies.map((d) => d.store).join("+")})`,
  );
  let conflict = false;
  try {
    await reg.register({ ...latest, dependencies: [{ store: "minio", role: "x", isolateBy: "object-prefix" }] });
  } catch (e) {
    conflict = e.code === "CONFLICT";
    console.log(`  re-register bu@${latest.version} with different spec → ${e.code} (immutable ✓)`);
  }

  console.log("\n=== (4) fresh pool (process-restart) → still there ===");
  await pool.end();
  const pool2 = makePool(DB_URL);
  const reg2 = new PgHarnessRegistry(sqlClient(pool2));
  const reread = await reg2.get("bu", "1.1.0");
  console.log(`  re-read bu@1.1.0 after reconnect → ${reread.id}@${reread.version}`);
  const ok = reread.version === "1.1.0" && conflict;
  console.log(ok ? "✅ harness specs persisted in Postgres (immutable, survives reconnect)" : "❌ unexpected");

  // 정리: 데모 row 삭제(테이블/마이그레이션 유지).
  await sqlClient(pool2).query("DELETE FROM assay_harnesses WHERE id = $1", ["bu"]);
  await pool2.end();
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
