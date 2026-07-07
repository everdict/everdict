// 라이브 검증: PgRunStore 가 실제 Postgres 에 run 을 영속한다 (마이그레이션 + 재기동 후에도 조회).
//
//  1) preflight → migrate (assay_runs 생성, 멱등)
//  2) PgRunStore: create(queued) → get → update(succeeded,result) → get → list(tenant)
//  3) 새 풀(= 프로세스 재기동 모사)로 같은 id 조회 → 영속 증명
//
// 사용: DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/postgres node scripts/live/pg-run-store.mjs

import { PgRunStore, makePool, migrate, preflight, sqlClient } from "../../packages/db/dist/index.js";

const URL = process.env.DATABASE_URL;
if (!URL) throw new Error("DATABASE_URL 필요 — 크리덴셜은 env 로만 (git 에 기본값 금지)");
const ID = `pglive-${Date.now().toString(36)}`;

function rec(status) {
  return {
    id: ID,
    tenant: "acme",
    harness: { id: "scripted", version: "latest" },
    caseId: "c1",
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
const RESULT = {
  caseId: "c1",
  harness: "scripted@latest",
  trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 10, outputTokens: 5, usd: 0.03 } }],
  snapshot: { kind: "repo", diff: "+hello", changedFiles: ["out.txt"], headSha: "abc" },
  scores: [{ graderId: "steps", metric: "tool_calls", value: 1 }],
};

async function main() {
  const pool = makePool(URL);
  const client = sqlClient(pool);

  console.log("=== (1) preflight + migrate ===");
  console.log("  preflight 0001:", await preflight(client, "0001_create_runs.sql"));
  const { applied } = await migrate(client);
  console.log("  migrate applied:", applied.length ? applied.join(", ") : "(none — already applied)");
  console.log("  preflight 0001 (after):", await preflight(client, "0001_create_runs.sql"));

  console.log("\n=== (2) PgRunStore lifecycle ===");
  const store = new PgRunStore(client);
  await store.create(rec("queued"));
  console.log("  created:", (await store.get(ID)).status);
  await store.update(ID, { status: "succeeded", result: RESULT, updatedAt: new Date().toISOString() });
  const got = await store.get(ID);
  console.log("  after update:", got.status, "| result.scores:", JSON.stringify(got.result.scores));
  console.log("  result.usd persisted (jsonb):", got.result.trace[0].cost.usd);
  const list = await store.list("acme");
  console.log(
    "  list(acme) includes it:",
    list.some((r) => r.id === ID),
  );
  await pool.end();

  console.log("\n=== (3) fresh pool (process-restart) → still there ===");
  const pool2 = makePool(URL);
  const store2 = new PgRunStore(sqlClient(pool2));
  const reread = await store2.get(ID);
  console.log(
    "  re-read after reconnect:",
    reread?.status,
    "| harness:",
    `${reread?.harness.id}@${reread?.harness.version}`,
  );
  const ok = reread?.status === "succeeded" && reread?.result?.trace?.[0]?.cost?.usd === 0.03;
  console.log(ok ? "✅ persisted in Postgres across reconnect (real durability)" : "❌ not persisted");

  // 정리: 이 데모 row 만 삭제(테이블/마이그레이션은 유지).
  await sqlClient(pool2).query("DELETE FROM assay_runs WHERE id = $1", [ID]);
  await pool2.end();
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
