// 라이브 e2e (SLICE 73): os-use 환경에서 실제 데스크탑 앱(hermes-desktop)을 "에이전트가 실제로 구동" 하는지 증명.
// SLICE 72 는 부팅+렌더+관측까지였고, 여기선 "태스크 수행"의 핵심인 *실 입력 주입 → 앱 상태전이 → os-use 관측* 을 증명한다.
//
//   메커니즘(컴퓨터-유즈 루프):
//     1) OsUseEnvironment.seed → docker env-container 안에서 Xvfb(:99) + hermes(Electron, ENABLE_CDP=1) 기동.
//     2) "에이전트"(harness) → playwright 로 CDP attach(이미 떠있는 Electron 에 붙기만) → "Connect to Remote Hermes"
//        버튼의 화면 좌표 계산(boundingBox + 창 오프셋 + devicePixelRatio).
//     3) *** 실제 OS 마우스 클릭 *** 을 xdotool 로 Xvfb 에 주입(= 컴퓨터-유즈 액션. 합성 DOM .click() 아님).
//     4) 앱이 반응했는지 playwright 로 독립 검증(Welcome → Remote 연결폼: "Server URL" 입력칸 등장).
//     5) scrot 로 클릭 전/후 스크린샷(os-use 관측) → host 로 회수해 육안 확인.
//   grader(command) 가 컨테이너 안에서 drive-result.json 을 읽어 ok && transitioned 를 pass 로 판정.
//
// 이미지는 scripts/live/Dockerfile.hermes(=/tmp/hermes-desktop/Dockerfile.everdict) 로 미리 빌드: everdict-hermes-drive:demo
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { OsUseEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";

const IMAGE = process.env.HERMES_IMAGE ?? "everdict-hermes-drive:demo";

// 컨테이너 안에서 도는 "에이전트" 드라이버(CommonJS — hermes 의 playwright 를 require). 실 OS 입력(xdotool)으로 GUI 구동.
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
    // 준비 신호 = 두 분기(welcome / install-issue) 모두에 있는 "Connect to Remote Hermes" 버튼.
    const remoteBtn = page.getByRole("button", { name: /Connect to Remote Hermes/i });
    await remoteBtn.waitFor({ timeout: 60000 });
    out.ready = true;
    out.url = page.url();
    out.welcomeTitle = await page.getByText("Welcome to Hermes One").isVisible().catch(() => false);
    out.dpr = await page.evaluate(() => window.devicePixelRatio);

    // before 상태(OS 스크린샷 + DOM 진실)
    sh("DISPLAY=:99 scrot -o /tmp/before.png");
    out.beforeBytes = fs.statSync("/tmp/before.png").size;
    out.beforeServerUrl = await page.getByText("Server URL").isVisible().catch(() => false);
    out.beforeInputs = await page.locator("input").count();

    // hermes X 윈도우(가장 큰 가시 창)의 화면 원점.
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

    // 버튼 뷰포트 CSS 박스 → 화면 px (창 오프셋 + dpr).
    await remoteBtn.scrollIntoViewIfNeeded().catch(() => {});
    const box = await remoteBtn.boundingBox();
    if (!box) throw new Error("remote button has no bounding box");
    out.box = box;
    const cx = Math.round(win.X + (box.x + box.width / 2) * out.dpr);
    const cy = Math.round(win.Y + (box.y + box.height / 2) * out.dpr);
    out.click = { cx, cy };

    // *** 실제 OS 마우스 클릭 *** — Xvfb 에 진짜 포인터 이벤트 주입(컴퓨터-유즈 액션).
    sh("DISPLAY=:99 xdotool mousemove --sync " + cx + " " + cy + " click 1");
    out.clicked = true;
    await sleep(1000);

    // 앱이 반응했는지 독립 검증: Welcome → Remote 연결폼으로 전이("Server URL" 라벨 + 입력칸 증가).
    out.serverUrlVisible = await page.getByText("Server URL").isVisible().catch(() => false);
    out.afterInputs = await page.locator("input").count();
    sh("DISPLAY=:99 scrot -o /tmp/after.png");
    out.afterBytes = fs.statSync("/tmp/after.png").size;
    out.beforeB64 = fs.readFileSync("/tmp/before.png").toString("base64");
    out.afterB64 = fs.readFileSync("/tmp/after.png").toString("base64");

    out.transitioned = out.serverUrlVisible && !out.beforeServerUrl && out.afterInputs > out.beforeInputs;
    out.ok = out.ready && out.clicked && out.transitioned;
    await browser.close(); // detach 만(앱은 계속 실행)
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

console.log("=== env-container 프로비저닝(데스크탑 컴퓨트 이미지) ===");
const compute = await driver.provision({ os: "linux", image: IMAGE, needs: ["desktop", "shell"] });

try {
  console.log("=== seed: Xvfb + hermes(Electron, ENABLE_CDP) 기동 ===");
  await env.seed(compute, {
    kind: "os-use",
    display: ":99",
    setup: [
      "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
      "cd /app && ENABLE_CDP=1 CDP_PORT=9222 DISPLAY=:99 ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage >/tmp/electron.log 2>&1 & sleep 10",
    ],
    screenshotPath: "/tmp/everdict-screen.png",
  });

  console.log("=== 에이전트 구동: CDP attach → 실 OS 클릭(xdotool) → 상태전이 검증 ===");
  await compute.writeFile("/tmp/drive.cjs", DRIVER);
  const run = await compute.exec("node /tmp/drive.cjs", { timeoutSec: 180 });
  process.stdout.write(run.stdout);
  if (run.stderr.trim()) console.error("[driver stderr]", run.stderr.slice(0, 800));

  const result = JSON.parse(await compute.readFile("/tmp/drive-result.json"));

  // 클릭 전/후 PNG 를 host 로 회수(육안 확인용).
  if (result.beforeB64) writeFileSync("/tmp/hermes-before.png", Buffer.from(result.beforeB64, "base64"));
  if (result.afterB64) writeFileSync("/tmp/hermes-after.png", Buffer.from(result.afterB64, "base64"));

  // os-use 관측: 최종 상태 스냅샷.
  const snapshot = await env.snapshot(compute);

  // grader(command): 컨테이너 안에서 drive-result.json 판정 → pass.
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

  console.log("\n--- 결과 ---");
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
      ? "\n✅ SLICE 73: 에이전트가 실제 hermes-desktop 을 *구동* — 실 OS 마우스 클릭(xdotool)으로 Welcome→Remote 연결폼 상태전이를 일으키고(playwright 독립검증), os-use(scrot)가 전/후를 관측. '부팅/렌더'를 넘어 '입력→앱 반응→관측' 컴퓨터-유즈 루프 증명."
      : "\n⚠️ 기대와 불일치(상태전이 미검증)",
  );
  await compute.dispose();
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("orchestrator error:", e);
  await compute.dispose().catch(() => {});
  process.exitCode = 1;
} finally {
  // 무거운 이미지/캐시 정리(디스크) — 내 이미지만. system prune 금지. (KEEP_IMAGE=1 이면 디버그용 보존)
  if (!process.env.KEEP_IMAGE) {
    try {
      execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });
    } catch {}
  }
}
