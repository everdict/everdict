// Live e2e: desktop app (new-machine scenario). Drives the real Electron shell (apps/desktop) with Playwright to
// verify that one click on "이 기기를 러너로 연결" on the account page brings a runner online (bridge→safeStorage→RunnerHost),
// and that a runtime=self:<id> run executes on this desktop and reports back to the workspace with a provenance tag.
// Design: docs/architecture/desktop-app.md (slice 5 live e2e).
//
// Set up:
//   pnpm build
//   PORT=8799 node apps/api/dist/main.js                                  # control plane (in-memory, dev-fallback auth)
//   CONTROL_PLANE_URL=http://localhost:8799 pnpm -F @everdict/web dev -- -p 3131   # web (Keycloak unset → dev fallback)
// Usage:
//   node scripts/live/desktop-runner.mjs
//   (headless/sandbox environments need --no-sandbox on electron, so the script adds it by default)
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { _electron } = require("playwright-core");
const electronPath = require("electron"); // in a node context this is the binary path string

const API = (process.env.EVERDICT_API_URL ?? "http://localhost:8799").replace(/\/$/, "");
const WEB = (process.env.EVERDICT_WEB_URL ?? "http://localhost:3131").replace(/\/$/, "");
const H = { "content-type": "application/json", "x-everdict-tenant": "default" }; // dev fallback → subject=dev
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, init = {}) => {
  const r = await fetch(`${API}${p}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${p} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// 0) Wait for the API and web to come up (the web dev first compile can be slow).
const waitHttp = async (url, label, timeoutMs = 120_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`${label} is not responding at ${url} — bring it up first per the Set up section.`);
};
await waitHttp(`${API}/healthz`, "control plane").catch(() => waitHttp(`${API}/me`, "control plane", 5_000));
await waitHttp(WEB, "web");
console.log(`▶ api=${API} web=${WEB}`);

// 1) Baseline runner list — to identify the "new" runner the one-click pair creates.
const before = new Set((await api("/runners")).runners.map((r) => r.id));

// 2) Launch the real desktop app — clean userData like a new machine (XDG_CONFIG_HOME=temp dir).
const configHome = mkdtempSync(path.join(tmpdir(), "everdict-desktop-e2e-"));
const appDir = new URL("../../apps/desktop", import.meta.url).pathname;
const electronApp = await _electron.launch({
  executablePath: electronPath,
  args: [appDir, "--no-sandbox", "--password-store=basic"], // e2e: no setuid sandbox + no keyring environment
  env: { ...process.env, EVERDICT_WEB_URL: WEB, EVERDICT_API_URL: API, XDG_CONFIG_HOME: configHome },
});
const cleanup = async () => {
  await electronApp.close().catch(() => {});
  rmSync(configHome, { recursive: true, force: true });
};

try {
  const page = await electronApp.firstWindow();
  // From the app window (= web tab) go to Account > Connected runners. dev fallback → default workspace, no login.
  await page.goto(`${WEB}/default/account?tab=runners`, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // 3) One-click — the button that appears once the bridge is detected (with 0 runners it shows in both the header and the empty state → first).
  const connect = page.getByRole("button", { name: "이 기기를 러너로 연결" }).first(); // ko-locale UI label — KEEP
  await connect.waitFor({ state: "visible", timeout: 120_000 });
  await connect.click();
  console.log("▶ one-click pairing clicked — waiting for the runner to come online …");

  // 4) Confirm the "이 기기" badge + online (bridge live status).
  await page.getByText("이 기기", { exact: true }).waitFor({ state: "visible", timeout: 60_000 }); // ko-locale UI label — KEEP
  console.log("✓ 'This device' live row shown on the account page");

  // 5) Confirm the server side also has a new runner and its label = hostname (appInfo auto-label).
  const runners = (await api("/runners")).runners.filter((r) => !before.has(r.id));
  if (runners.length !== 1) throw new Error(`✗ expected exactly 1 new runner: ${JSON.stringify(runners)}`);
  const runner = runners[0];
  if (runner.label !== hostname()) throw new Error(`✗ label is not the hostname: ${runner.label}`);
  console.log(`✓ paired runner ${runner.id} (label=${runner.label})`);

  // 6) Submit a run with runtime=self:<id> — this desktop (the main process RunnerHost) must execute it.
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
    throw new Error(`✗ provenance mismatch: ${JSON.stringify(prov)}`);

  console.log(
    `✓ PASS — desktop one-click pairing alone ran run ${rec.id} on this device and reported back (provenance=${JSON.stringify(prov)})`,
  );
} finally {
  await cleanup();
}
// Note: repeated runs leave old e2e runner records behind (personal-owned list) — revoke manually if needed.
process.exit(0);
