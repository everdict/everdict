// 라이브 e2e: *플러그인 번들 원샷 설치* → pinch 벤치마크 실행 → **리더보드(harness × model)**.
// 유저 시나리오(멀티테넌트 SaaS, HTTP API 만):
//   ① POST /plugins/install : codex(하니스) + pinch(벤치마크) 번들을 한 번에 등록 — 일반화된 self-serve 등록.
//   ② POST /scorecards      : pinch 를 하니스로 실행(judge 채점). codex 는 그 CLI+런타임이 필요하므로,
//      기본은 builtin 'scripted' 로 실행해 install→run→leaderboard 루프 전체를 무-외부의존으로 실증한다.
//      실제 codex 실행은 ASSAY_HARNESS=codex + docker 런타임(코덱스 설치 이미지)로 스왑(아래 주석).
//   ③ GET /scorecards/leaderboard : 한 벤치마크의 (harness × model) 랭킹 행을 출력.
// judge 채점에는 모델이 필요 → LiteLLM(:4000) 키를 CP judge env 로 주입(pinch-hermes-e2e 와 동일).
//
// 사용: node scripts/live/codex-pinch-leaderboard.mjs   (apps/api/dist 빌드 필요; LiteLLM 있으면 judge 실채점)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8789";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-assay-tenant": "default" };
const HARNESS = process.env.ASSAY_HARNESS ?? "scripted"; // 실제 codex 실행은 ASSAY_HARNESS=codex + ASSAY_RUNTIME=<codex 이미지 docker 런타임>
const RUNTIME = process.env.ASSAY_RUNTIME; // 미설정이면 기본 백엔드(scripted 는 호스트 in-process)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function litellmKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    return (readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8").match(
      /^LITELLM_MASTER_KEY=(.+)$/m,
    ) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = litellmKey();
const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (path) => (await fetch(`${BASE}${path}`, { headers: H })).json();

const bundle = JSON.parse(readFileSync(new URL("../../examples/plugins/codex-pinch/bundle.json", import.meta.url)));

console.log(`=== 컨트롤플레인 기동 (apps/api dist, dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT,
    ASSAY_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: "",
    ...(KEY ? { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1" } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));

let ok = false;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane 기동 실패");

  // ① 번들 원샷 설치
  console.log("\n=== ① POST /plugins/install (codex + pinch 번들) ===");
  const inst = await post("/plugins/install", bundle);
  console.log(`  → ${inst.status}`);
  for (const r of inst.json.results ?? []) console.log(`     ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);
  const installOk = inst.status === 200 && (inst.json.results ?? []).every((r) => r.status === "ok" || r.status === "conflict");

  // ② pinch 실행(judge 채점). 기본 scripted(무-외부의존), 실 codex 는 ASSAY_HARNESS=codex + ASSAY_RUNTIME 로 스왑.
  console.log(`\n=== ② POST /scorecards (pinch-building-dashboards × ${HARNESS}) ===`);
  const run = await post("/scorecards", {
    dataset: { id: "pinch-building-dashboards", version: "1.0.0" },
    harness: { id: HARNESS },
    ...(RUNTIME ? { runtime: RUNTIME } : {}),
    ...(KEY ? { judge: { provider: "openai", model: process.env.ASSAY_JUDGE_MODEL ?? "gpt-5.4-mini" } } : {}),
  });
  console.log(`  → ${run.status} id=${run.json.id ?? "-"}`);
  let rec = run.json;
  if (run.json.id) {
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      rec = await get(`/scorecards/${run.json.id}`);
      process.stdout.write(`  status=${rec.status}\r`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    console.log(`\n  최종 status=${rec.status}${rec.models?.primary ? ` model=${rec.models.primary}` : " model=unknown"}`);
  }

  // ③ 리더보드
  console.log("\n=== ③ GET /scorecards/leaderboard (pinch-building-dashboards × harness×model) ===");
  const lb = await get("/scorecards/leaderboard?dataset=pinch-building-dashboards&metric=judge");
  for (const row of lb.rows ?? [])
    console.log(
      `  #${row.rank} ${row.harness.id}@${row.harness.version} × ${row.model ?? "unknown"} — score=${row.score ?? "–"} (runs=${row.runs})`,
    );

  ok = installOk && (lb.rows ?? []).length > 0;
  console.log(
    ok
      ? "\n✅ install(번들 원샷) → run(pinch) → leaderboard(harness×model) 루프 실증. codex 는 ASSAY_HARNESS=codex + ASSAY_RUNTIME=<codex docker 런타임> 로 스왑."
      : "\n⚠️ 일부 단계 불일치(위 로그 참고). judge 실채점엔 LiteLLM(:4000) 필요; codex 실행엔 codex 설치 런타임 필요.",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
