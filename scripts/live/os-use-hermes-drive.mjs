// Live e2e (SLICE 73): prove that in the os-use environment the "agent actually drives" a real desktop app (hermes-desktop).
// SLICE 72 went up to boot+render+observe; here we prove the core of "task execution" — *real input injection → app state transition → os-use observation*.
//
//   Mechanism (computer-use loop):
//     1) OsUseEnvironment.seed → start Xvfb(:99) + hermes (Electron, ENABLE_CDP=1) inside the docker env-container.
//     2) "agent" (harness) → CDP attach via playwright (just attaches to the already-running Electron) → compute the
//        screen coordinates of the "Connect to Remote Hermes" button (boundingBox + window offset + devicePixelRatio).
//     3) *** a real OS mouse click *** injected into Xvfb via xdotool (= computer-use action; not a synthetic DOM .click()).
//     4) independently verify the app reacted via playwright (Welcome → Remote connect form: "Server URL" input appears).
//     5) scrot captures before/after screenshots (os-use observation) → pulled back to host for visual inspection.
//   The grader (command) reads drive-result.json inside the container and passes if ok && transitioned.
//
// The image is pre-built via scripts/live/Dockerfile.hermes (=/tmp/hermes-desktop/Dockerfile.everdict): everdict-hermes-drive:demo
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { OsUseEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";

const IMAGE = process.env.HERMES_IMAGE ?? "everdict-hermes-drive:demo";

// The "agent" driver that runs inside the container (CommonJS — requires hermes's playwright). Drives the GUI with real OS input (xdotool).
const DRIVER = String.raw`
const { chromium } = require("/app/node_modules/playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const sh = (c) => execFileSync("bash", ["-lc", c], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = { ok: false };
  try {
    let browser = null;
    for (let i = 0; i < 45 && !browser; i++) {
      try { browser = await chromium.connectOverCDP("http://127.0.0.1:9222"); }
      catch { await sleep(1000); }
    }
    if (!browser) throw new Error("CDP attach timeout: Electron not up on :9222");
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => /index\.html/.test(p.url())) || ctx.pages()[0];
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    // Ready signal = the "Connect to Remote Hermes" button present in both branches (welcome / install-issue).
    const remoteBtn = page.getByRole("button", { name: /Connect to Remote Hermes/i });
    await remoteBtn.waitFor({ timeout: 60000 });
    out.ready = true;
    out.url = page.url();
    out.welcomeTitle = await page.getByText("Welcome to Hermes One").isVisible().catch(() => false);
    out.dpr = await page.evaluate(() => window.devicePixelRatio);

    // before state (OS screenshot + DOM truth)
    sh("DISPLAY=:99 scrot -o /tmp/before.png");
    out.beforeBytes = fs.statSync("/tmp/before.png").size;
    out.beforeServerUrl = await page.getByText("Server URL").isVisible().catch(() => false);
    out.beforeInputs = await page.locator("input").count();

    // Screen origin of the hermes X window (the largest visible window).
    const ids = sh("DISPLAY=:99 xdotool search --onlyvisible --name '.' 2>/dev/null || true").split(/\s+/).filter(Boolean);
    let win = null;
    for (const id of ids) {
      try {
        const g = Object.fromEntries(sh("DISPLAY=:99 xdotool getwindowgeometry --shell " + id).split("\n").map((l) => l.split("=")));
        const area = (+g.WIDTH) * (+g.HEIGHT);
        if ((+g.WIDTH) > 300 && (!win || area > win.area)) win = { id, X: +g.X, Y: +g.Y, W: +g.WIDTH, H: +g.HEIGHT, area };
      } catch {}
    }
    if (!win) throw new Error("no hermes X window found");
    out.win = win;

    // Button viewport CSS box → screen px (window offset + dpr).
    await remoteBtn.scrollIntoViewIfNeeded().catch(() => {});
    const box = await remoteBtn.boundingBox();
    if (!box) throw new Error("remote button has no bounding box");
    out.box = box;
    const cx = Math.round(win.X + (box.x + box.width / 2) * out.dpr);
    const cy = Math.round(win.Y + (box.y + box.height / 2) * out.dpr);
    out.click = { cx, cy };

    // *** real OS mouse click *** — inject a genuine pointer event into Xvfb (computer-use action).
    sh("DISPLAY=:99 xdotool mousemove --sync " + cx + " " + cy + " click 1");
    out.clicked = true;
    await sleep(1000);

    // Independently verify the app reacted: transition Welcome → Remote connect form ("Server URL" label + input count increases).
    out.serverUrlVisible = await page.getByText("Server URL").isVisible().catch(() => false);
    out.afterInputs = await page.locator("input").count();
    sh("DISPLAY=:99 scrot -o /tmp/after.png");
    out.afterBytes = fs.statSync("/tmp/after.png").size;
    out.beforeB64 = fs.readFileSync("/tmp/before.png").toString("base64");
    out.afterB64 = fs.readFileSync("/tmp/after.png").toString("base64");

    out.transitioned = out.serverUrlVisible && !out.beforeServerUrl && out.afterInputs > out.beforeInputs;
    out.ok = out.ready && out.clicked && out.transitioned;
    await browser.close(); // detach only (the app keeps running)
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  fs.writeFileSync("/tmp/drive-result.json", JSON.stringify(out));
  const { beforeB64, afterB64, ...summary } = out;
  console.log(JSON.stringify(summary));
})();
`;

const driver = new DockerDriver();
const env = new OsUseEnvironment();

console.log("=== provision env-container (desktop compute image) ===");
const compute = await driver.provision({ os: "linux", image: IMAGE, needs: ["desktop", "shell"] });

try {
  console.log("=== seed: start Xvfb + hermes (Electron, ENABLE_CDP) ===");
  await env.seed(compute, {
    kind: "os-use",
    display: ":99",
    setup: [
      "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
      "cd /app && ENABLE_CDP=1 CDP_PORT=9222 DISPLAY=:99 ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage >/tmp/electron.log 2>&1 & sleep 10",
    ],
    screenshotPath: "/tmp/everdict-screen.png",
  });

  console.log("=== drive agent: CDP attach → real OS click (xdotool) → verify state transition ===");
  await compute.writeFile("/tmp/drive.cjs", DRIVER);
  const run = await compute.exec("node /tmp/drive.cjs", { timeoutSec: 180 });
  process.stdout.write(run.stdout);
  if (run.stderr.trim()) console.error("[driver stderr]", run.stderr.slice(0, 800));

  const result = JSON.parse(await compute.readFile("/tmp/drive-result.json"));

  // Pull before/after PNGs back to host (for visual inspection).
  if (result.beforeB64) writeFileSync("/tmp/hermes-before.png", Buffer.from(result.beforeB64, "base64"));
  if (result.afterB64) writeFileSync("/tmp/hermes-after.png", Buffer.from(result.afterB64, "base64"));

  // os-use observation: final-state snapshot.
  const snapshot = await env.snapshot(compute);

  // grader (command): judge drive-result.json inside the container → pass.
  const [grader] = makeGraders([
    {
      id: "command",
      config: {
        cmd: 'node -e \'const r=require("/tmp/drive-result.json"); if(!r.ok||!r.transitioned){console.log("FAIL "+(r.error||JSON.stringify(r)).slice(0,300));process.exit(1)} console.log("ready="+r.ready+" clicked@"+JSON.stringify(r.click)+" serverUrlVisible="+r.serverUrlVisible+" inputs "+r.beforeInputs+"->"+r.afterInputs+" shot "+r.beforeBytes+"->"+r.afterBytes)\'',
        cwd: "/tmp",
        metric: "gui-drive",
      },
    },
  ]);
  const score = await grader.grade({ case: { id: "hermes-drive" }, trace: [], snapshot, compute });

  console.log("\n--- result ---");
  console.log("ready            =", result.ready);
  console.log("welcomeTitle     =", result.welcomeTitle);
  console.log("dpr              =", result.dpr);
  console.log("window           =", JSON.stringify(result.win));
  console.log("clicked at (px)  =", JSON.stringify(result.click));
  console.log("beforeServerUrl  =", result.beforeServerUrl, ` (inputs: ${result.beforeInputs})`);
  console.log("serverUrlVisible =", result.serverUrlVisible, ` (inputs: ${result.afterInputs})`);
  console.log("screenshot bytes =", result.beforeBytes, "->", result.afterBytes);
  console.log("snapshot.kind    =", snapshot.kind, " windows:", JSON.stringify(snapshot.windows));
  if (result.error) console.log("driver.error     =", result.error.slice(0, 500));
  console.log(`\ngrader[gui-drive]: pass=${score.pass}  ${String(score.detail).split("\n")[0]}`);

  const ok = score.pass === true && result.transitioned === true;
  console.log(
    ok
      ? "\n✅ SLICE 73: the agent *drives* a real hermes-desktop — a real OS mouse click (xdotool) triggers the Welcome→Remote connect-form state transition (independently verified by playwright), and os-use (scrot) observes before/after. Proves the 'input → app reaction → observation' computer-use loop, beyond 'boot/render'."
      : "\n⚠️ does not match expectation (state transition not verified)",
  );
  await compute.dispose();
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("orchestrator error:", e);
  await compute.dispose().catch(() => {});
  process.exitCode = 1;
} finally {
  // Clean up heavy image/cache (disk) — only my image. No system prune. (KEEP_IMAGE=1 keeps it for debugging)
  if (!process.env.KEEP_IMAGE) {
    try {
      execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });
    } catch {}
  }
}
