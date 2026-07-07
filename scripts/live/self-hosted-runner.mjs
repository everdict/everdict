// 라이브 e2e: 셀프호스티드 러너. 멤버가 자기 머신(이 프로세스)에서 워크스페이스의 잡을 받아(pull) 돌리고
// 결과를 회신한다(push→pull). 워크스페이스의 공유 하니스/데이터셋을 "런타임만 바꿔"(self:<runnerId>) 내 호스트에서.
// 검증: 페어링 → everdict runner 기동 → runtime=self:<id> 로 run 제출 → succeeded + result.provenance.ranOn=self-hosted.
// 설계: docs/architecture/self-hosted-runner.md.
//
// 준비:
//   pnpm build
//   node apps/api/dist/main.js            # 컨트롤플레인 API (:8787, in-memory, dev 폴백 인증)
// 사용:
//   node scripts/live/self-hosted-runner.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
// dev 폴백(미인증) → subject=dev, workspace=default. 러너도 같은 dev 소유로 페어링되어 self: 라우팅이 맞물린다.
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
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

// 2) 이 머신을 러너로 기동(everdict runner). 페어링 토큰으로 /mcp 에 인증.
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

  // 한 워크스페이스(x-everdict-tenant 헤더)에서 runtime=self:<id> 로 run 을 돌리고 결과를 검증한다.
  // scripted 하니스 — 로컬, 외부 의존 없음(이 머신에서 실행). dev 폴백 subject="dev" 라 워크스페이스가 달라도 owner 동일.
  const runOnSelf = async (workspace) => {
    const wsHeaders = { "x-everdict-tenant": workspace };
    const submitted = await api("/runs", {
      method: "POST",
      headers: wsHeaders,
      body: JSON.stringify({
        harness: { id: "scripted", version: "0" },
        case: {
          id: `e2e-${workspace}`,
          env: { kind: "repo", source: { files: {} } },
          task: "say hi",
          graders: [{ id: "steps" }],
          timeoutSec: 120,
          tags: ["e2e"],
          placement: { target: `self:${runner.id}` }, // ← "런타임만 바꿔" — 내 로컬 호스트
        },
      }),
    });
    console.log(`▶ [${workspace}] submitted run ${submitted.id} → self:${runner.id}`);
    let rec;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      rec = await api(`/runs/${submitted.id}`, { headers: wsHeaders });
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    if (rec.status !== "succeeded") throw new Error(`[${workspace}] run ${rec.status}: ${JSON.stringify(rec.error)}`);
    const prov = rec.result?.provenance;
    if (prov?.ranOn !== "self-hosted" || prov.runner !== runner.id || prov.by !== "dev")
      throw new Error(`[${workspace}] ✗ 프로비넌스 불일치: ${JSON.stringify(prov)}`);
    console.log(`✓ [${workspace}] run ${rec.id} (tenant=${rec.tenant}) ← 같은 러너(${prov.runner})에서 실행, 태그됨`);
    return rec;
  };

  // 3) 기본 워크스페이스에서 1건.
  await runOnSelf("default");

  // 4) 크로스 워크스페이스: 같은 러너가 다른 워크스페이스(team-b)의 잡도 받는다(러너는 소유자의 여러 워크스페이스를 한 큐로).
  const other = await runOnSelf("team-b");
  if (other.tenant !== "team-b") throw new Error("✗ 두 번째 run 의 워크스페이스가 team-b 가 아님");

  console.log(
    `✓ PASS — 한 러너(${runner.id})가 default + team-b 두 워크스페이스의 잡을 수행하고 각 워크스페이스에 태그됨`,
  );
} finally {
  cleanup();
}
process.exit(0);
