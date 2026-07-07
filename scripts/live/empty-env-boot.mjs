// 셀프호스트 최소 프로필 계약: 컨트롤플레인이 "빈 env" 로도 부팅되는지 실제 프로세스로 증명한다.
//   — DATABASE_URL/KEYCLOAK_*/GITHUB_APP_*/NOMAD/K8S/시크릿 키 전부 없음 → in-memory 스토어,
//     dev-fallback 인증(x-everdict-tenant), 통합 전부 비활성. 이게 깨지면 원커맨드 셀프호스트가 깨진다.
// 사용(빌드 후): node scripts/live/empty-env-boot.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const PORT = process.env.EVERDICT_BOOT_TEST_PORT ?? "18787";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 의도적으로 최소 env 만 물려준다(PATH/HOME 은 node 실행에 필요) — .env 파일도 읽지 않는다.
const child = spawn(process.execPath, ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT },
  stdio: ["ignore", "inherit", "inherit"],
});
const kill = () => {
  if (!child.killed) child.kill("SIGTERM");
};
process.on("exit", kill);

let exited = false;
child.on("exit", (code) => {
  exited = true;
  if (code !== 0 && code !== null) {
    console.error(`✗ 컨트롤플레인이 빈 env 부팅에 실패 (exit ${code})`);
    process.exit(1);
  }
});

async function main() {
  // 1) /healthz 가 뜰 때까지 폴링(최대 30초)
  let healthy = false;
  for (let i = 0; i < 60 && !exited; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // 아직 안 뜸 — 재시도
    }
    await sleep(500);
  }
  if (!healthy) throw new Error("30초 내 /healthz 미응답 — 빈 env 부팅 실패");
  console.log("✓ /healthz ok (빈 env, in-memory)");

  // 2) dev-fallback 테넌트로 기본 읽기 라우트가 동작하는지(인증 미강제 = 셀프호스트 최소 프로필)
  const res = await fetch(`${BASE}/harnesses`, { headers: { "x-everdict-tenant": "default" } });
  if (!res.ok) throw new Error(`/harnesses ${res.status} — dev-fallback 경로 실패`);
  await res.json();
  console.log("✓ GET /harnesses ok (dev-fallback 테넌트)");

  console.log("PASS: 빈-env 부팅 계약 유지");
}

main()
  .then(() => {
    kill();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`✗ ${err.message}`);
    kill();
    process.exit(1);
  });
