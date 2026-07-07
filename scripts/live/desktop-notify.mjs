// 라이브 e2e: 데스크톱 독립 알림(N6, docs/architecture/notifications.md). 웹 세션 없이 —
// 원클릭 페어링(러너 토큰 확보) 후 앱 창을 숨긴 상태에서, 다른 곳(API)에서 시킨 run 이 완료되면
// 메인 프로세스 워처가 러너 토큰으로 피드를 폴링해 OS 알림을 발화하는지 검증한다.
// 준비:
//   pnpm build
//   PORT=8799 node apps/api/dist/main.js                                        # 컨트롤플레인(in-memory, dev 폴백)
//   CONTROL_PLANE_URL=http://localhost:8799 KEYCLOAK_CLIENT_ID= pnpm -C apps/web exec next dev -p 3131
// 사용:
//   node scripts/live/desktop-notify.mjs   (그래픽 세션 필요 — X/$DISPLAY 없으면 Electron 기동 불가.
//    헤드리스 검증은 워처를 직접 구동: 페어링→실 MCP 세션→run 완료→notify 발화 — N6 검증 로그 참고)
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { _electron } = require("playwright-core");
const electronPath = require("electron");

const API = (process.env.EVERDICT_API_URL ?? "http://localhost:8799").replace(/\/$/, "");
const WEB = (process.env.EVERDICT_WEB_URL ?? "http://localhost:3131").replace(/\/$/, "");
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init = {}) => {
  const r = await fetch(`${API}${p}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${p} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const configHome = mkdtempSync(path.join(tmpdir(), "everdict-notify-"));
const appDir = new URL("../../apps/desktop", import.meta.url).pathname;
const app = await _electron.launch({
  executablePath: electronPath,
  args: [appDir, "--no-sandbox", "--password-store=basic"],
  env: { ...process.env, EVERDICT_WEB_URL: WEB, EVERDICT_API_URL: API, XDG_CONFIG_HOME: configHome },
});
const mainLogs = [];
app.process().stderr?.on("data", (d) => mainLogs.push(String(d)));
const cleanup = async () => {
  await app.close().catch(() => {});
  rmSync(configHome, { recursive: true, force: true });
};

try {
  // 1) 원클릭 페어링(러너 토큰 확보가 목적 — 이후 웹 세션은 쓰지 않는다).
  const page = await app.firstWindow();
  await page.goto(`${WEB}/default/account?tab=runners`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const connect = page.getByRole("button", { name: "이 기기를 러너로 연결" }).first();
  await connect.waitFor({ state: "visible", timeout: 120_000 });
  await connect.click();
  await page.getByText("이 기기", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  console.log("✓ 원클릭 페어링 — 러너 토큰 확보");
  const started = mainLogs.some((l) => l.includes("독립 알림 워처 시작"));
  console.log(started ? "✓ 독립 알림 워처 시작 로그 확인" : "… 워처 시작 로그 대기(브로드캐스트 지연 가능)");

  // 2) 앱 창을 숨긴다 — 트레이 상주(웹을 보지 않는 유저) 시나리오.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.hide();
  });
  console.log("✓ 앱 창 숨김(트레이 상주 상태)");

  // 3) 다른 곳(API)에서 run 을 시킨다 — 완료되면 피드 적재(recipient=dev=러너 owner).
  const sub = await api("/runs", {
    method: "POST",
    body: JSON.stringify({
      harness: { id: "scripted", version: "0" },
      case: {
        id: "n6-e2e",
        env: { kind: "repo", source: { files: {} } },
        task: "say hi",
        graders: [{ id: "steps" }],
        timeoutSec: 60,
        tags: ["e2e"],
      },
    }),
  });
  for (let i = 0; i < 30; i++) {
    const rec = await api(`/runs/${sub.id}`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
    await sleep(1000);
  }
  console.log(`✓ run ${sub.id} 완료 — 워처 폴링(≤30s) 대기`);

  // 4) 메인 프로세스가 러너 토큰으로 피드를 읽어 OS 알림을 발화했는지(웹 세션/창 무관).
  let fired = false;
  for (let i = 0; i < 45 && !fired; i++) {
    await sleep(1000);
    fired = mainLogs.some((l) => l.includes("네이티브 알림 발화") && l.includes("Run 완료"));
  }
  if (!fired) throw new Error(`✗ 워처 발화 로그 없음 — main logs:\n${mainLogs.slice(-10).join("")}`);
  console.log("✓ 메인 프로세스 워처가 OS 알림 발화(러너 토큰 — 웹 세션 불필요)");

  console.log("✓ PASS — 데스크톱 독립 알림(N6): 페어링만으로, 창 숨김 상태에서 작업 완료 OS 알림 수신");
} finally {
  await cleanup();
}
process.exit(0);
