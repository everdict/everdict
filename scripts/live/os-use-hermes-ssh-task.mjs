// 라이브 e2e (SLICE 75): hermes-desktop *풀 태스크* — SSH 연결 end-to-end + VLM 자동 채점.
// SLICE73 은 UI 패널 전이까지, SLICE74 는 VLM 채점 도입. 여기선 둘을 합쳐 "진짜 작업 완수"를 증명한다:
//   에이전트가 SSH 폼을 실제로 채우고(실 OS 키보드) 연결 → hermes 가 *진짜 SSH 터널*을 열고(real sshd, 키인증,
//   -L 포트포워드, /health 200) Welcome 을 떠나 메인으로 진입 → 그 결과 화면을 VLM 이 보고 성공 판정.
//
//   토폴로지(전부 실제): 같은 env-container 안에 sshd(:22, ed25519 키인증) + /health 200 스텁(:8642).
//     hermes 의 testSshConnection 이 `ssh -N -L <free>:127.0.0.1:8642 root@127.0.0.1` 터널을 열고 /health 폴링 →
//     200 이어야 ok=true → setSshConfig → onRecheck → splash("Starting SSH tunnel…") → main. (루프백이지만 진짜 SSH.)
//
//   2중 증명: (a) 결정론 — hermes 가 폼을 떠났고(Host 입력 사라짐, sshError 없음) + `ssh -N -L` 터널 프로세스 생존;
//             (b) VLM — after(진입 후)=pass, before(SSH 폼)=fail (SLICE74 실 프로덕션 judge 경로 재사용).
//
// 이미지: /tmp/hermes-desktop/Dockerfile.ssh → everdict-hermes-ssh:demo. 키: OPENAI_API_KEY env 또는 infra/litellm/.env.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { OsUseEnvironment } from "../../packages/environments/dist/index.js";
import { JudgeGrader, judgeFromEnv } from "../../packages/graders/dist/index.js";

const IMAGE = process.env.HERMES_IMAGE ?? "everdict-hermes-ssh:demo";

// --- VLM judge env(LiteLLM OpenAI-호환 프록시) ---
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
  console.error("VLM judge 미구성(OPENAI_API_KEY/.env 필요).");
  process.exit(2);
}

// 컨테이너 안 "에이전트" 드라이버: playwright(좌표/검증) + xdotool(실 OS 입력)로 SSH 폼을 채우고 연결.
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

    // 윈도우 화면 원점 + dpr (CSS 박스 → 화면 px 변환용).
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

    // 1) Welcome → "Connect via SSH" (실 OS 클릭).
    const sshBtn = page.getByRole("button", { name: /Connect via SSH/i });
    await sshBtn.waitFor({ timeout: 60000 });
    out.ready = true;
    await osClick(sshBtn);

    // 2) SSH 폼 등장 대기 + 실 OS 키보드로 채우기.
    const hostInput = page.getByPlaceholder("192.168.1.100 or myserver.local");
    await hostInput.waitFor({ timeout: 15000 });
    out.formShown = true;
    await osType(hostInput, "127.0.0.1");
    await osType(page.getByPlaceholder("hermes"), "root");
    await osType(page.getByPlaceholder("~/.ssh/id_rsa"), "/root/.ssh/id_rsa");
    sh("DISPLAY=:99 scrot -o /tmp/before.png"); // 채운 폼(아직 미연결 = 비목표)
    out.beforeBytes = fs.statSync("/tmp/before.png").size;
    out.filledHost = await hostInput.inputValue().catch(() => "");

    // 3) "Connect via SSH" 제출(실 OS 클릭). (host+user 채워져 활성화됨)
    const submit = page.getByRole("button", { name: /Connect via SSH/i });
    await osClick(submit);
    out.clickedConnect = true;

    // 4) 결과 대기: 폼을 떠나면(Host 입력 사라짐) 성공, sshError 뜨면 실패. 터널/health 폴링에 시간 필요.
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
    sh("DISPLAY=:99 scrot -o /tmp/after.png"); // 연결 후 화면(splash/main = 목표)
    out.afterBytes = fs.statSync("/tmp/after.png").size;

    // 5) 시스템 결정론 증거: 실제 ssh -L 터널 프로세스 + 폼 이탈.
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

console.log("=== env-container 프로비저닝(hermes+ssh 이미지) ===");
const compute = await driver.provision({ os: "linux", image: IMAGE, needs: ["desktop", "shell"] });

try {
  console.log("=== seed: sshd(키인증) + /health 스텁(:8642) + Xvfb + hermes ===");
  await env.seed(compute, {
    kind: "os-use",
    display: ":99",
    setup: [
      // sshd: 호스트키 + root ed25519 키쌍(자기자신 authorized_keys) + 루트 키로그인 허용 + 기동.
      "mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh",
      "ssh-keygen -A",
      "test -f /root/.ssh/id_rsa || ssh-keygen -t ed25519 -f /root/.ssh/id_rsa -N '' -q",
      "cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys",
      "grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config",
      "/usr/sbin/sshd",
      // 원격 Hermes API 스텁: /health 에 200 (testSshConnection 의 checkTunnelHealth 통과용).
      'node -e \'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(8642,"127.0.0.1",()=>console.log("health-stub:8642"))\' >/tmp/health.log 2>&1 & sleep 1',
      // 가상 디스플레이 + hermes(Electron, CDP).
      "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
      "cd /app && ENABLE_CDP=1 CDP_PORT=9222 DISPLAY=:99 ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage >/tmp/electron.log 2>&1 & sleep 10",
    ],
    screenshotPath: "/tmp/after.png",
  });

  console.log("=== 에이전트: SSH 폼 작성(실 OS 키보드) → 연결 → 결과 관측 ===");
  await compute.writeFile("/tmp/drive.cjs", DRIVER);
  const run = await compute.exec("node /tmp/drive.cjs", { timeoutSec: 240 });
  process.stdout.write(run.stdout);
  if (run.stderr.trim()) console.error("[driver stderr]", run.stderr.slice(0, 600));
  const result = JSON.parse(await compute.readFile("/tmp/ssh-result.json"));

  if (result.beforeB64) writeFileSync("/tmp/hermes-ssh-before.png", Buffer.from(result.beforeB64, "base64"));
  if (result.afterB64) writeFileSync("/tmp/hermes-ssh-after.png", Buffer.from(result.afterB64, "base64"));

  // --- VLM 채점(실 프로덕션 경로: JudgeGrader → resolveScreenshot(docker compute base64) → VLM) ---
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

  console.log("\n--- 결정론 증거 ---");
  console.log("ready/formShown   =", result.ready, "/", result.formShown);
  console.log("filledHost        =", result.filledHost);
  console.log("clickedConnect    =", result.clickedConnect);
  console.log("advanced(폼 이탈) =", result.advanced, " afterHostVisible=", result.afterHostVisible);
  console.log("sshError          =", JSON.stringify(result.sshError));
  console.log("tunnelProc        =", result.tunnelProc || "(none)");
  if (result.error) console.log("driver.error      =", result.error.slice(0, 400));
  console.log("\n--- VLM 채점(after=목표, before=비목표) ---");
  console.log(`after  pass=${vAfter.pass} score=${vAfter.value} :: ${String(vAfter.detail).slice(0, 160)}`);
  console.log(`before pass=${vBefore.pass} score=${vBefore.value} :: ${String(vBefore.detail).slice(0, 160)}`);

  const deterministic = result.success === true;
  const vlmOk = vAfter.pass === true && vBefore.pass === false;
  const ok = deterministic && vlmOk;
  console.log(
    ok
      ? "\n✅ SLICE 75: hermes 풀 태스크 — 에이전트가 SSH 폼을 실 OS 키보드로 채우고 연결 → hermes 가 진짜 SSH 터널(real sshd+키인증+포트포워드+/health 200)을 열고 Welcome 을 떠나 진입. 결정론(폼 이탈 + ssh -L 터널 프로세스)과 VLM(after=pass, before=fail) 양쪽 증명. 데스크탑 풀 태스크가 end-to-end 실행 + 자동 채점됨."
      : `\n⚠️ 불일치: deterministic=${deterministic} vlmOk=${vlmOk}`,
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
