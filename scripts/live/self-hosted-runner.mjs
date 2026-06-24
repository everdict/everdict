// 라이브 e2e: 셀프호스티드 러너. 멤버가 자기 머신(이 프로세스)에서 워크스페이스의 잡을 받아(pull) 돌리고
// 결과를 회신한다(push→pull). 워크스페이스의 공유 하니스/데이터셋을 "런타임만 바꿔"(self:<runnerId>) 내 호스트에서.
// 검증: 페어링 → assay runner 기동 → runtime=self:<id> 로 run 제출 → succeeded + result.provenance.ranOn=self-hosted.
// 설계: docs/architecture/self-hosted-runner.md.
//
// 준비:
//   pnpm build
//   node apps/api/dist/main.js            # 컨트롤플레인 API (:8787, in-memory, dev 폴백 인증)
// 사용:
//   node scripts/live/self-hosted-runner.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.ASSAY_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
// dev 폴백(미인증) → subject=dev, workspace=default. 러너도 같은 dev 소유로 페어링되어 self: 라우팅이 맞물린다.
const H = { "content-type": "application/json", "x-assay-tenant": "default" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// 1) 디바이스 페어링 → rnr_ 토큰(1회 노출).
const { runner, token } = await api("/runners", {
  method: "POST",
  body: JSON.stringify({ label: "e2e-laptop", capabilities: ["repo"] }),
});
console.log(`▶ paired runner ${runner.id} (${runner.label})`);

// 2) 이 머신을 러너로 기동(assay runner). 페어링 토큰으로 /mcp 에 인증.
const runnerProc = spawn(
  process.execPath,
  ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", B, "--poll-interval-ms", "1000"],
  { stdio: "inherit" },
);
const cleanup = () => {
  if (!runnerProc.killed) runnerProc.kill("SIGINT");
};
process.on("exit", cleanup);

try {
  await sleep(2500); // 러너 MCP 연결 대기

  // 3) runtime=self:<id> 로 run 제출. scripted 하니스 — 로컬, 외부 의존 없음(이 머신에서 실행).
  const submitted = await api("/runs", {
    method: "POST",
    body: JSON.stringify({
      harness: { id: "scripted", version: "0" },
      case: {
        id: "e2e-1",
        env: { kind: "repo", source: { files: {} } },
        task: "say hi",
        graders: [{ id: "steps" }],
        timeoutSec: 120,
        tags: ["e2e"],
        placement: { target: `self:${runner.id}` }, // ← "런타임만 바꿔" — 내 로컬 호스트
      },
    }),
  });
  console.log(`▶ submitted run ${submitted.id} → self:${runner.id}`);

  // 4) 폴링 → succeeded + 프로비넌스 태그.
  let rec;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    rec = await api(`/runs/${submitted.id}`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  if (rec.status !== "succeeded") throw new Error(`run ${rec.status}: ${JSON.stringify(rec.error)}`);

  const prov = rec.result?.provenance;
  console.log("▶ provenance:", JSON.stringify(prov));
  if (prov?.ranOn !== "self-hosted") throw new Error("✗ 프로비넌스 태그 누락(ranOn !== self-hosted)");
  if (prov.runner !== runner.id || prov.by !== "dev") throw new Error("✗ 프로비넌스 runner/by 불일치");
  console.log(
    `✓ PASS — run ${rec.id} 가 셀프호스티드 러너(${prov.runner}, by ${prov.by})에서 실행되고 워크스페이스에 태그됨`,
  );
} finally {
  cleanup();
}
process.exit(0);
