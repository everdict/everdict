// Live e2e (SLICE 75): hermes-desktop *full task* — SSH connection end-to-end + VLM auto-grading.
// SLICE73 went up to UI panel transition, SLICE74 introduced VLM grading. Here we combine both to prove "real task completion":
//   the agent actually fills the SSH form (real OS keyboard) and connects → hermes opens a *real SSH tunnel* (real sshd, key auth,
//   -L port-forward, /health 200), leaves Welcome, and enters main → a VLM looks at the resulting screen and passes.
//
//   Topology (all real): sshd (:22, ed25519 key auth) + /health 200 stub (:8642) in the same env-container.
//     hermes's testSshConnection opens a `ssh -N -L <free>:127.0.0.1:8642 root@127.0.0.1` tunnel and polls /health →
//     must be 200 for ok=true → setSshConfig → onRecheck → splash ("Starting SSH tunnel…") → main. (loopback but real SSH.)
//
//   Dual proof: (a) deterministic — hermes left the form (Host input gone, no sshError) + the `ssh -N -L` tunnel process is alive;
//               (b) VLM — after (post-entry)=pass, before (SSH form)=fail (reuses the SLICE74 real-production judge path).
//
// Image: /tmp/hermes-desktop/Dockerfile.ssh → everdict-hermes-ssh:demo. Key: OPENAI_API_KEY env or infra/litellm/.env.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { OsUseEnvironment } from "../../packages/environments/dist/index.js";
import { JudgeGrader, judgeFromEnv } from "../../packages/graders/dist/index.js";

const IMAGE = process.env.HERMES_IMAGE ?? "everdict-hermes-ssh:demo";

// --- VLM judge env (LiteLLM OpenAI-compatible proxy) ---
function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8");
    return (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const judge = judgeFromEnv({
  EVERDICT_JUDGE_MODEL: process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini",
  EVERDICT_JUDGE_PROVIDER: "openai",
  OPENAI_API_KEY: masterKey() ?? "",
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1",
});
if (!judge) {
  console.error("VLM judge not configured (OPENAI_API_KEY/.env required).");
  process.exit(2);
}

// The in-container "agent" driver: fills the SSH form and connects with playwright (coordinates/verification) + xdotool (real OS input).
const DRIVER = String.raw`
const { chromium } = require("/app/node_modules/playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const sh = (c) => execFileSync("bash", ["-lc", c], { encoding: "utf8" }).trim();
const shq = (c) => { try { return sh(c); } catch (e) { return String(e && e.stdout || ""); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = { ok: false };
  try {
    let browser = null;
    for (let i = 0; i < 45 && !browser; i++) {
      try { browser = await chromium.connectOverCDP("http://127.0.0.1:9222"); } catch { await sleep(1000); }
    }
    if (!browser) throw new Error("CDP attach timeout");
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => /index\.html/.test(p.url())) || ctx.pages()[0];
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Window screen origin + dpr (for CSS box → screen px conversion).
    out.dpr = await page.evaluate(() => window.devicePixelRatio);
    let win = null;
    {
      const ids = shq("DISPLAY=:99 xdotool search --onlyvisible --name '.'").split(/\s+/).filter(Boolean);
      for (const id of ids) {
        try {
          const g = Object.fromEntries(sh("DISPLAY=:99 xdotool getwindowgeometry --shell " + id).split("\n").map((l) => l.split("=")));
          const area = (+g.WIDTH) * (+g.HEIGHT);
          if ((+g.WIDTH) > 300 && (!win || area > win.area)) win = { X: +g.X, Y: +g.Y, area };
        } catch {}
      }
    }
    if (!win) throw new Error("no hermes window");
    const center = async (loc) => {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const b = await loc.boundingBox();
      if (!b) throw new Error("no bbox");
      return { x: Math.round(win.X + (b.x + b.width / 2) * out.dpr), y: Math.round(win.Y + (b.y + b.height / 2) * out.dpr) };
    };
    const osClick = async (loc) => { const c = await center(loc); sh("DISPLAY=:99 xdotool mousemove --sync " + c.x + " " + c.y + " click 1"); await sleep(400); };
    const osType = async (loc, text) => { await osClick(loc); sh("DISPLAY=:99 xdotool type --clearmodifiers --delay 25 -- " + JSON.stringify(text)); await sleep(250); };

    // 1) Welcome → "Connect via SSH" (real OS click).
    const sshBtn = page.getByRole("button", { name: /Connect via SSH/i });
    await sshBtn.waitFor({ timeout: 60000 });
    out.ready = true;
    await osClick(sshBtn);

    // 2) Wait for the SSH form to appear + fill it with a real OS keyboard.
    const hostInput = page.getByPlaceholder("192.168.1.100 or myserver.local");
    await hostInput.waitFor({ timeout: 15000 });
    out.formShown = true;
    await osType(hostInput, "127.0.0.1");
    await osType(page.getByPlaceholder("hermes"), "root");
    await osType(page.getByPlaceholder("~/.ssh/id_rsa"), "/root/.ssh/id_rsa");
    sh("DISPLAY=:99 scrot -o /tmp/before.png"); // filled form (not yet connected = non-goal)
    out.beforeBytes = fs.statSync("/tmp/before.png").size;
    out.filledHost = await hostInput.inputValue().catch(() => "");

    // 3) Submit "Connect via SSH" (real OS click). (enabled once host+user are filled)
    const submit = page.getByRole("button", { name: /Connect via SSH/i });
    await osClick(submit);
    out.clickedConnect = true;

    // 4) Wait for the result: leaving the form (Host input gone) = success, sshError shown = failure. Tunnel/health polling takes time.
    let advanced = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const hostVisible = await hostInput.isVisible().catch(() => false);
      if (!hostVisible) { advanced = true; break; }
    }
    out.afterHostVisible = await hostInput.isVisible().catch(() => false);
    out.sshError = (await page.locator(".welcome-remote-error").innerText().catch(() => "")) || "";
    out.advanced = advanced;
    await sleep(1500);
    sh("DISPLAY=:99 scrot -o /tmp/after.png"); // post-connection screen (splash/main = goal)
    out.afterBytes = fs.statSync("/tmp/after.png").size;

    // 5) System deterministic evidence: a real ssh -L tunnel process + leaving the form.
    out.tunnelProc = shq("pgrep -af 'ssh .*-L' | head -1");
    out.beforeB64 = fs.readFileSync("/tmp/before.png").toString("base64");
    out.afterB64 = fs.readFileSync("/tmp/after.png").toString("base64");

    out.success = out.clickedConnect && advanced && !out.sshError && /ssh .*-L/.test(out.tunnelProc);
    out.ok = out.ready && out.formShown && out.success;
    await browser.close();
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  fs.writeFileSync("/tmp/ssh-result.json", JSON.stringify(out));
  const { beforeB64, afterB64, ...sm } = out;
  console.log(JSON.stringify(sm));
})();
`;

const driver = new DockerDriver();
const env = new OsUseEnvironment();

console.log("=== provision env-container (hermes+ssh image) ===");
const compute = await driver.provision({ os: "linux", image: IMAGE, needs: ["desktop", "shell"] });

try {
  console.log("=== seed: sshd (key auth) + /health stub (:8642) + Xvfb + hermes ===");
  await env.seed(compute, {
    kind: "os-use",
    display: ":99",
    setup: [
      // sshd: host key + root ed25519 keypair (self as authorized_keys) + allow root key login + start.
      "mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh",
      "ssh-keygen -A",
      "test -f /root/.ssh/id_rsa || ssh-keygen -t ed25519 -f /root/.ssh/id_rsa -N '' -q",
      "cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys",
      "grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config",
      "/usr/sbin/sshd",
      // Remote Hermes API stub: 200 on /health (to pass testSshConnection's checkTunnelHealth).
      'node -e \'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(8642,"127.0.0.1",()=>console.log("health-stub:8642"))\' >/tmp/health.log 2>&1 & sleep 1',
      // Virtual display + hermes (Electron, CDP).
      "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
      "cd /app && ENABLE_CDP=1 CDP_PORT=9222 DISPLAY=:99 ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage >/tmp/electron.log 2>&1 & sleep 10",
    ],
    screenshotPath: "/tmp/after.png",
  });

  console.log("=== agent: fill SSH form (real OS keyboard) → connect → observe result ===");
  await compute.writeFile("/tmp/drive.cjs", DRIVER);
  const run = await compute.exec("node /tmp/drive.cjs", { timeoutSec: 240 });
  process.stdout.write(run.stdout);
  if (run.stderr.trim()) console.error("[driver stderr]", run.stderr.slice(0, 600));
  const result = JSON.parse(await compute.readFile("/tmp/ssh-result.json"));

  if (result.beforeB64) writeFileSync("/tmp/hermes-ssh-before.png", Buffer.from(result.beforeB64, "base64"));
  if (result.afterB64) writeFileSync("/tmp/hermes-ssh-after.png", Buffer.from(result.afterB64, "base64"));

  // --- VLM grading (real production path: JudgeGrader → resolveScreenshot(docker compute base64) → VLM) ---
  const task = "Hermes should connect to a remote machine over SSH (it opens an SSH tunnel and loads the app).";
  const rubric =
    "PASS only if the app has advanced PAST the SSH connection form — e.g. a splash like 'Starting SSH tunnel…' or " +
    "the main app screen — with NO connection-error message. The SSH connection form itself (Host/Username/Key fields) " +
    "or a red connection error is NOT the goal.";
  const grader = new JudgeGrader(judge, { id: "vlm-ssh", useScreenshot: true, rubric });
  const judgeShot = async (ref) =>
    grader.grade({
      case: { id: "hermes-ssh", env: { kind: "os-use" }, task, graders: [], timeoutSec: 60, tags: [] },
      trace: [],
      snapshot: { kind: "os-use", screenshotRef: ref, windows: [] },
      compute,
    });
  const vAfter = await judgeShot("/tmp/after.png");
  const vBefore = await judgeShot("/tmp/before.png");

  console.log("\n--- deterministic evidence ---");
  console.log("ready/formShown   =", result.ready, "/", result.formShown);
  console.log("filledHost        =", result.filledHost);
  console.log("clickedConnect    =", result.clickedConnect);
  console.log("advanced(left form)=", result.advanced, " afterHostVisible=", result.afterHostVisible);
  console.log("sshError          =", JSON.stringify(result.sshError));
  console.log("tunnelProc        =", result.tunnelProc || "(none)");
  if (result.error) console.log("driver.error      =", result.error.slice(0, 400));
  console.log("\n--- VLM grading (after=goal, before=non-goal) ---");
  console.log(`after  pass=${vAfter.pass} score=${vAfter.value} :: ${String(vAfter.detail).slice(0, 160)}`);
  console.log(`before pass=${vBefore.pass} score=${vBefore.value} :: ${String(vBefore.detail).slice(0, 160)}`);

  const deterministic = result.success === true;
  const vlmOk = vAfter.pass === true && vBefore.pass === false;
  const ok = deterministic && vlmOk;
  console.log(
    ok
      ? "\n✅ SLICE 75: hermes full task — the agent fills the SSH form with a real OS keyboard and connects → hermes opens a genuine SSH tunnel (real sshd + key auth + port-forward + /health 200), leaves Welcome, and enters. Proven both by determinism (left form + ssh -L tunnel process) and VLM (after=pass, before=fail). The desktop full task runs end-to-end + is auto-graded."
      : `\n⚠️ mismatch: deterministic=${deterministic} vlmOk=${vlmOk}`,
  );
  await compute.dispose();
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("orchestrator error:", e);
  await compute.dispose().catch(() => {});
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP_IMAGE) {
    try {
      execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });
    } catch {}
  }
}
