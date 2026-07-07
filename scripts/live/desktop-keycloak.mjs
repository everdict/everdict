// Live e2e: desktop × real Keycloak (D5/D8 verification). Full new-machine scenario —
//   no server configured → first-run setup screen (setup.html), enter the server address (D8)
//   → app window renders the web → Auth.js+Keycloak OIDC redirect login (inside the webview, D5: token stays in web cookies only)
//   → Account > Connected runners → one-click pair (D3/D7) → 'This device' online.
// Set up (use the already-running dev stack):
//   bash scripts/dev/up.sh          # Keycloak(:8081) + control plane(:8787)
//   pnpm -C apps/web dev            # web(:3001, Keycloak configured)
// Usage:
//   node scripts/live/desktop-keycloak.mjs
//   (env: EVERDICT_E2E_WEB=http://<host>:3001 · EVERDICT_E2E_USER/PASS=alice/alice · EVERDICT_E2E_WS=acme)
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { _electron } = require("playwright-core");
const electronPath = require("electron");

const WEB = (process.env.EVERDICT_E2E_WEB ?? "http://localhost:3001").replace(/\/$/, "");
const USER = process.env.EVERDICT_E2E_USER ?? "alice";
const PASS = process.env.EVERDICT_E2E_PASS ?? "alice";
const WS = process.env.EVERDICT_E2E_WS ?? "acme";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0) Confirm the web is up.
try {
  await fetch(WEB);
} catch {
  throw new Error(`${WEB} is not responding — bring up the dev stack first per the Set up section.`);
}

// 1) Like a new machine: clean userData + boot without EVERDICT_WEB_URL → the setup screen must appear (D8).
const configHome = mkdtempSync(path.join(tmpdir(), "everdict-desktop-kc-"));
const appDir = new URL("../../apps/desktop", import.meta.url).pathname;
// Exclude EVERDICT_WEB_URL via destructuring (new-machine simulation) — delete trips the performance lint, so use the spread-exclusion pattern.
const { EVERDICT_WEB_URL: _webUrl, ...inheritedEnv } = process.env;
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
    throw new Error(`✗ first window is not the setup screen: ${setup.url()}`);
  console.log("✓ no server configured → first-run setup screen shown");

  // 2) Enter the server address → save (everdictSetup bridge) → switch to app window.
  await setup.fill("#url", WEB);
  await setup.click("#save");
  let main;
  for (let i = 0; i < 60 && !main; i++) {
    await sleep(500);
    main = app.windows().find((w) => w.url().startsWith(WEB));
  }
  if (!main) throw new Error("✗ app window did not open after saving the server");
  console.log(`✓ server saved (config.json) → app window renders ${WEB}`);

  // 3) Go to a protected page → Auth.js login → Keycloak form (redirect inside the webview) → sign in.
  await main.goto(`${WEB}/${WS}/account?tab=runners`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const signin = main.getByText("Sign in with Keycloak");
  if (await signin.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await signin.click();
    await main.locator("#username").waitFor({ state: "visible", timeout: 30_000 });
    console.log("✓ reached the Keycloak login form (top-level redirect policy works)");
    await main.fill("#username", USER);
    await main.fill("#password", PASS);
    await main.click("#kc-login");
  }
  await main.getByText("연결된 러너").first().waitFor({ state: "visible", timeout: 60_000 }); // ko-locale UI label — KEEP
  if (!main.url().startsWith(`${WEB}/${WS}`)) throw new Error(`✗ workspace mismatch after login: ${main.url()}`);
  console.log(`✓ ${USER} logged in → ${WS} account page (session in web cookies only — D5)`);

  // The login redirect can drop the ?tab= query, so click the tab directly.
  await main.getByRole("tab", { name: "연결된 러너" }).click(); // ko-locale UI label — KEEP

  // 4) One-click pair → 'This device' online (runner connects to /mcp with the rnr_ token).
  const connect = main.getByRole("button", { name: "이 기기를 러너로 연결" }).first(); // ko-locale UI label — KEEP
  await connect.waitFor({ state: "visible", timeout: 30_000 });
  await connect.click();
  await main.getByText("이 기기", { exact: true }).waitFor({ state: "visible", timeout: 60_000 }); // ko-locale UI label — KEEP
  console.log("✓ one-click pair → 'This device' live row (online)");

  console.log(
    "✓ PASS — setup screen → server save → real Keycloak login → one-click pair, all verified on the real desktop",
  );
  console.log(`  (an e2e runner record remains under ${USER}@${WS} — revoke it from the account page if needed)`);
} finally {
  await cleanup();
}
process.exit(0);
