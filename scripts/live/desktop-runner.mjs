// 라이브 e2e: 데스크톱 앱(신규 머신 시나리오). 실제 Electron 셸(apps/desktop)을 Playwright 로 구동해
// 계정 페이지의 "이 기기를 러너로 연결" 원클릭만으로 러너가 온라인이 되고(브리지→safeStorage→RunnerHost),
// runtime=self:<id> 런이 이 데스크톱에서 실행되어 provenance 태그와 함께 워크스페이스로 회신됨을 검증한다.
// 설계: docs/architecture/desktop-app.md (슬라이스 5 라이브 e2e).
//
// 준비:
//   pnpm build
//   PORT=8799 node apps/api/dist/main.js                                  # 컨트롤플레인 (in-memory, dev 폴백 인증)
//   CONTROL_PLANE_URL=http://localhost:8799 pnpm -F @assay/web dev -- -p 3131   # 웹 (Keycloak 미설정 → dev 폴백)
// 사용:
//   node scripts/live/desktop-runner.mjs
//   (헤드리스/샌드박스 환경은 electron 에 --no-sandbox 가 필요해 스크립트가 기본으로 붙인다)
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { _electron } = require("playwright-core");
const electronPath = require("electron"); // node 컨텍스트에선 바이너리 경로 문자열

const API = (process.env.ASSAY_API_URL ?? "http://localhost:8799").replace(/\/$/, "");
const WEB = (process.env.ASSAY_WEB_URL ?? "http://localhost:3131").replace(/\/$/, "");
const H = { "content-type": "application/json", "x-assay-tenant": "default" }; // dev 폴백 → subject=dev
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, init = {}) => {
  const r = await fetch(`${API}${p}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${p} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// 0) API·웹 기동 대기(웹 dev 첫 컴파일이 느릴 수 있다).
const waitHttp = async (url, label, timeoutMs = 120_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`${label} 이 ${url} 에서 응답하지 않습니다 — 준비 섹션대로 먼저 띄우세요.`);
};
await waitHttp(`${API}/healthz`, "컨트롤플레인").catch(() => waitHttp(`${API}/me`, "컨트롤플레인", 5_000));
await waitHttp(WEB, "웹");
console.log(`▶ api=${API} web=${WEB}`);

// 1) 베이스라인 러너 목록 — 원클릭이 만든 "새" 러너를 식별하기 위해.
const before = new Set((await api("/runners")).runners.map((r) => r.id));

// 2) 실제 데스크톱 앱 기동 — 새 머신처럼 깨끗한 userData(XDG_CONFIG_HOME=임시 디렉터리).
const configHome = mkdtempSync(path.join(tmpdir(), "assay-desktop-e2e-"));
const appDir = new URL("../../apps/desktop", import.meta.url).pathname;
const electronApp = await _electron.launch({
  executablePath: electronPath,
  args: [appDir, "--no-sandbox", "--password-store=basic"], // e2e: setuid 샌드박스 부재 + 키링 없는 환경 대비
  env: { ...process.env, ASSAY_WEB_URL: WEB, ASSAY_API_URL: API, XDG_CONFIG_HOME: configHome },
});
const cleanup = async () => {
  await electronApp.close().catch(() => {});
  rmSync(configHome, { recursive: true, force: true });
};

try {
  const page = await electronApp.firstWindow();
  // 앱 창(=웹 탭)에서 계정 > 연결된 러너 탭으로. dev 폴백이라 로그인 없이 default 워크스페이스.
  await page.goto(`${WEB}/default/account?tab=runners`, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // 3) 원클릭 — 브리지가 감지되면 나타나는 버튼(러너 0대면 헤더+빈상태 두 곳에 뜬다 → first).
  const connect = page.getByRole("button", { name: "이 기기를 러너로 연결" }).first();
  await connect.waitFor({ state: "visible", timeout: 120_000 });
  await connect.click();
  console.log("▶ 원클릭 페어링 클릭됨 — 러너 온라인 대기 …");

  // 4) "이 기기" 배지 + 온라인(브리지 라이브 상태) 확인.
  await page.getByText("이 기기", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  console.log("✓ 계정 페이지에 '이 기기' 라이브 행 표시");

  // 5) 서버 쪽에도 새 러너가 생겼고 라벨=호스트명(appInfo 자동 라벨)인지 확인.
  const runners = (await api("/runners")).runners.filter((r) => !before.has(r.id));
  if (runners.length !== 1) throw new Error(`✗ 새 러너가 1개가 아님: ${JSON.stringify(runners)}`);
  const runner = runners[0];
  if (runner.label !== hostname()) throw new Error(`✗ 라벨이 호스트명이 아님: ${runner.label}`);
  console.log(`✓ paired runner ${runner.id} (label=${runner.label})`);

  // 6) runtime=self:<id> 로 run 제출 — 이 데스크톱(메인 프로세스의 RunnerHost)이 실행해야 한다.
  const submitted = await api("/runs", {
    method: "POST",
    body: JSON.stringify({
      harness: { id: "scripted", version: "0" },
      case: {
        id: "desktop-e2e",
        env: { kind: "repo", source: { files: {} } },
        task: "say hi",
        graders: [{ id: "steps" }],
        timeoutSec: 120,
        tags: ["e2e", "desktop"],
        placement: { target: `self:${runner.id}` },
      },
    }),
  });
  console.log(`▶ submitted run ${submitted.id} → self:${runner.id}`);
  let rec;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    rec = await api(`/runs/${submitted.id}`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  if (rec?.status !== "succeeded") throw new Error(`✗ run ${rec?.status}: ${JSON.stringify(rec?.error)}`);
  const prov = rec.result?.provenance;
  if (prov?.ranOn !== "self-hosted" || prov.runner !== runner.id || prov.by !== "dev")
    throw new Error(`✗ 프로비넌스 불일치: ${JSON.stringify(prov)}`);

  console.log(
    `✓ PASS — 데스크톱 원클릭 페어링만으로 run ${rec.id} 이 이 기기에서 실행·회신됨 (provenance=${JSON.stringify(prov)})`,
  );
} finally {
  await cleanup();
}
// 참고: 반복 실행 시 이전 e2e 러너 레코드가 남는다(개인 소유 목록) — 필요하면 수동 revoke.
process.exit(0);
