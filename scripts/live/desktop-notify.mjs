// live e2e: desktop independent notification (N6, docs/architecture/notifications.md). Without a web session —
// after one-click pairing (obtaining the runner token) and with the app window hidden, when a run triggered elsewhere (API) completes,
// verify that the main-process watcher polls the feed with the runner token and fires an OS notification.
// Prereq:
//   pnpm build
//   PORT=8799 node apps/api/dist/main.js                                        # control plane (in-memory, dev fallback)
//   CONTROL_PLANE_URL=http://localhost:8799 KEYCLOAK_CLIENT_ID= pnpm -C apps/web exec next dev -p 3131
// Usage:
//   node scripts/live/desktop-notify.mjs   (needs a graphical session — Electron cannot start without X/$DISPLAY.
//    for headless verification, drive the watcher directly: pairing → real MCP session → run completes → notify fires — see the N6 verification log)
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
  // 1) one-click pairing (goal is to obtain the runner token — the web session is not used afterward).
  const page = await app.firstWindow();
  await page.goto(`${WEB}/default/account?tab=runners`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const connect = page.getByRole("button", { name: "이 기기를 러너로 연결" }).first(); // ko-locale UI label — KEEP
  await connect.waitFor({ state: "visible", timeout: 120_000 });
  await connect.click();
  await page.getByText("이 기기", { exact: true }).waitFor({ state: "visible", timeout: 60_000 }); // ko-locale UI label — KEEP
  console.log("✓ one-click pairing — runner token obtained");
  const started = mainLogs.some((l) => l.includes("Independent notification watcher started"));
  console.log(
    started
      ? "✓ independent notification watcher start log confirmed"
      : "… waiting for watcher start log (broadcast may lag)",
  );

  // 2) hide the app window — tray-resident (user not watching the web) scenario.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.hide();
  });
  console.log("✓ app window hidden (tray-resident state)");

  // 3) trigger a run elsewhere (API) — on completion it writes to the feed (recipient=dev=runner owner).
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
  console.log(`✓ run ${sub.id} completed — waiting for watcher poll (≤30s)`);

  // 4) whether the main process read the feed with the runner token and fired an OS notification (independent of web session/window).
  let fired = false;
  for (let i = 0; i < 45 && !fired; i++) {
    await sleep(1000);
    fired = mainLogs.some((l) => l.includes("Fired native notification") && l.includes("Run completed"));
  }
  if (!fired) throw new Error(`✗ no watcher fire log — main logs:\n${mainLogs.slice(-10).join("")}`);
  console.log("✓ main-process watcher fired an OS notification (runner token — no web session needed)");

  console.log(
    "✓ PASS — desktop independent notification (N6): with pairing alone and the window hidden, received an OS notification on job completion",
  );
} finally {
  await cleanup();
}
process.exit(0);
