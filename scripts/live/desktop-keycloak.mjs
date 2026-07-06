// 라이브 e2e: 데스크톱 × 실 Keycloak(D5/D8 검증). 신규 머신 시나리오 그대로 —
//   서버 미구성 → 첫 실행 설정 화면(setup.html)에 서버 주소 입력(D8)
//   → 앱 창이 웹을 렌더 → Auth.js+Keycloak OIDC 리다이렉트 로그인(웹뷰 안, D5: 토큰은 웹 쿠키에만)
//   → 계정 > 연결된 러너 → 원클릭 페어(D3/D7) → '이 기기' 온라인.
// 준비(이미 떠 있는 dev 스택 사용):
//   bash scripts/dev/up.sh          # Keycloak(:8081) + 컨트롤플레인(:8787)
//   pnpm -C apps/web dev            # 웹(:3001, Keycloak 구성)
// 사용:
//   node scripts/live/desktop-keycloak.mjs
//   (env: ASSAY_E2E_WEB=http://100.69.164.81:3001 · ASSAY_E2E_USER/PASS=alice/alice · ASSAY_E2E_WS=acme)
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { _electron } = require("playwright-core");
const electronPath = require("electron");

const WEB = (process.env.ASSAY_E2E_WEB ?? "http://100.69.164.81:3001").replace(/\/$/, "");
const USER = process.env.ASSAY_E2E_USER ?? "alice";
const PASS = process.env.ASSAY_E2E_PASS ?? "alice";
const WS = process.env.ASSAY_E2E_WS ?? "acme";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0) 웹 기동 확인.
try {
  await fetch(WEB);
} catch {
  throw new Error(`${WEB} 이 응답하지 않습니다 — 준비 섹션대로 dev 스택을 먼저 띄우세요.`);
}

// 1) 신규 머신처럼: 깨끗한 userData + ASSAY_WEB_URL 없이 기동 → 설정 화면이 떠야 한다(D8).
const configHome = mkdtempSync(path.join(tmpdir(), "assay-desktop-kc-"));
const appDir = new URL("../../apps/desktop", import.meta.url).pathname;
// ASSAY_WEB_URL 은 구조분해로 제외(신규 머신 시뮬레이션) — delete 는 성능 린트 대상이라 스프레드 제외 패턴 사용.
const { ASSAY_WEB_URL: _webUrl, ...inheritedEnv } = process.env;
const env = { ...inheritedEnv, XDG_CONFIG_HOME: configHome };
const app = await _electron.launch({
  executablePath: electronPath,
  args: [appDir, "--no-sandbox", "--password-store=basic"],
  env,
});
const cleanup = async () => {
  await app.close().catch(() => {});
  rmSync(configHome, { recursive: true, force: true });
};

try {
  const setup = await app.firstWindow();
  await setup.waitForLoadState("domcontentloaded");
  if (!setup.url().startsWith("file://") || !setup.url().endsWith("setup.html"))
    throw new Error(`✗ 첫 창이 설정 화면이 아님: ${setup.url()}`);
  console.log("✓ 서버 미구성 → 첫 실행 설정 화면 표시");

  // 2) 서버 주소 입력 → 저장(assaySetup 브리지) → 앱 창 전환.
  await setup.fill("#url", WEB);
  await setup.click("#save");
  let main;
  for (let i = 0; i < 60 && !main; i++) {
    await sleep(500);
    main = app.windows().find((w) => w.url().startsWith(WEB));
  }
  if (!main) throw new Error("✗ 서버 저장 후 앱 창이 열리지 않음");
  console.log(`✓ 서버 저장(config.json) → 앱 창이 ${WEB} 렌더`);

  // 3) 보호된 페이지로 → Auth.js 로그인 → Keycloak 폼(웹뷰 안 리다이렉트) → 로그인.
  await main.goto(`${WEB}/${WS}/account?tab=runners`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const signin = main.getByText("Sign in with Keycloak");
  if (await signin.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await signin.click();
    await main.locator("#username").waitFor({ state: "visible", timeout: 30_000 });
    console.log("✓ Keycloak 로그인 폼 도달(탑레벨 리다이렉트 정책 동작)");
    await main.fill("#username", USER);
    await main.fill("#password", PASS);
    await main.click("#kc-login");
  }
  await main.getByText("연결된 러너").first().waitFor({ state: "visible", timeout: 60_000 });
  if (!main.url().startsWith(`${WEB}/${WS}`)) throw new Error(`✗ 로그인 후 워크스페이스 불일치: ${main.url()}`);
  console.log(`✓ ${USER} 로그인 → ${WS} 계정 페이지(세션은 웹 쿠키에만 — D5)`);

  // 로그인 리다이렉트가 ?tab= 쿼리를 잃을 수 있어 탭을 직접 클릭한다.
  await main.getByRole("tab", { name: "연결된 러너" }).click();

  // 4) 원클릭 페어 → '이 기기' 온라인(러너가 rnr_ 토큰으로 /mcp 접속).
  const connect = main.getByRole("button", { name: "이 기기를 러너로 연결" }).first();
  await connect.waitFor({ state: "visible", timeout: 30_000 });
  await connect.click();
  await main.getByText("이 기기", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  console.log("✓ 원클릭 페어 → '이 기기' 라이브 행(온라인)");

  console.log("✓ PASS — 설정 화면→서버 저장→실 Keycloak 로그인→원클릭 페어까지 실 데스크톱에서 검증됨");
  console.log(`  (e2e 러너 레코드가 ${USER}@${WS} 에 남습니다 — 필요 시 계정 페이지에서 해제)`);
} finally {
  await cleanup();
}
process.exit(0);
