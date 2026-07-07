// 라이브 e2e: 워크스페이스-공유 셀프호스티드 러너(self:ws:<id>). admin 이 팀 자원 러너를 등록하면
// 그 워크스페이스 멤버 누구나 "런타임만 바꿔"(self:ws:<runnerId>) 팀 러너에서 잡을 돌린다(팀 빌드서버/CI).
// 개인 러너(self:<id>, own-pays)와 달리 비용은 워크스페이스에 귀속(provenance.by="ws:<workspace>").
// 검증:
//   1) POST /workspace/runners 로 팀 러너 페어링(owner=ws:<workspace>)
//   2) everdict runner 기동(그 rnr_ 토큰 → principal.subject="ws:<workspace>")
//   3) runtime=self:ws:<id> 로 run 제출 → succeeded + provenance.ranOn=self-hosted + by="ws:<workspace>"(=워크스페이스-결제)
//   4) 크로스 워크스페이스 격리: 다른 워크스페이스가 self:ws:<id> 를 타깃하면 NOT_FOUND(dispatch 가 owner 를 잡 tenant 에서 파생)
// 설계: docs/architecture/self-hosted-runtime-and-runners.md (슬라이스 3).
//
// 준비:
//   pnpm build
//   node apps/api/dist/main.js            # 컨트롤플레인 API (:8787, in-memory, dev 폴백 인증)
// 사용:
//   node scripts/live/workspace-shared-runner.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const WS = "default"; // dev 폴백 → subject=dev, workspace=default, roles=[admin]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-everdict-tenant": WS, ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// 1) 워크스페이스-공유 러너 페어링(admin) → owner=ws:default, rnr_ 토큰(1회 노출).
const { runner, token } = await api("/workspace/runners", {
  method: "POST",
  body: JSON.stringify({ label: "team-ci", capabilities: ["git"] }),
});
console.log(`▶ paired WORKSPACE runner ${runner.id} (${runner.label}) — owner=ws:${WS}`);

// 2) 이 머신을 팀 러너로 기동. 토큰의 subject=ws:<workspace> 라 self:ws 큐를 leasing 한다(러너 코어 무변경).
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

  // 3) 멤버가 runtime=self:ws:<id> 로 run 제출 → 팀 러너에서 실행, 비용은 워크스페이스에 귀속.
  const submitted = await api("/runs", {
    method: "POST",
    body: JSON.stringify({
      harness: { id: "scripted", version: "0" },
      case: {
        id: "e2e-ws-shared",
        env: { kind: "repo", source: { files: {} } },
        task: "say hi",
        graders: [{ id: "steps" }],
        timeoutSec: 120,
        tags: ["e2e"],
        placement: { target: `self:ws:${runner.id}` }, // ← 워크스페이스-공유 러너
      },
    }),
  });
  console.log(`▶ submitted run ${submitted.id} → self:ws:${runner.id}`);
  let rec;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    rec = await api(`/runs/${submitted.id}`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  if (rec.status !== "succeeded") throw new Error(`run ${rec.status}: ${JSON.stringify(rec.error)}`);
  const prov = rec.result?.provenance;
  if (prov?.ranOn !== "self-hosted" || prov.runner !== runner.id)
    throw new Error(`✗ 프로비넌스 불일치: ${JSON.stringify(prov)}`);
  if (prov.by !== `ws:${WS}`)
    throw new Error(`✗ 워크스페이스-결제 아님(by=${prov.by}, 기대 ws:${WS}) — 팀 러너인데 own-pays 로 태그됨`);
  console.log(`✓ run ${rec.id} ← 팀 러너(${prov.runner})에서 실행, 비용 귀속 by=${prov.by} (워크스페이스-결제)`);

  // 4) 크로스 워크스페이스 격리: 다른 워크스페이스(team-b)가 같은 self:ws:<id> 를 타깃하면 그 워크스페이스의
  //    공유 러너로 해석되어(owner=ws:team-b) 존재하지 않으므로 NOT_FOUND — 팀 러너는 소유 워크스페이스 전용.
  const crossSubmit = await api("/runs", {
    method: "POST",
    headers: { "x-everdict-tenant": "team-b" },
    body: JSON.stringify({
      harness: { id: "scripted", version: "0" },
      case: {
        id: "e2e-cross-ws",
        env: { kind: "repo", source: { files: {} } },
        task: "say hi",
        graders: [{ id: "steps" }],
        timeoutSec: 60,
        tags: ["e2e"],
        placement: { target: `self:ws:${runner.id}` },
      },
    }),
  });
  let cross;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    cross = await api(`/runs/${crossSubmit.id}`, { headers: { "x-everdict-tenant": "team-b" } });
    if (cross.status === "succeeded" || cross.status === "failed") break;
  }
  if (cross.status !== "failed")
    throw new Error(`✗ 크로스 워크스페이스 격리 실패 — team-b 가 default 의 팀 러너를 탈취(status=${cross.status})`);
  console.log(`✓ 크로스 워크스페이스 격리 — team-b 는 default 팀 러너를 타깃 못 함(run ${cross.status}: NOT_FOUND)`);

  console.log(`✓ PASS — 워크스페이스-공유 러너 self:ws:${runner.id}: 팀 실행 + 워크스페이스-결제 + 크로스ws 격리`);
} finally {
  cleanup();
}
process.exit(0);
