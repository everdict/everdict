// 레퍼런스 데스크탑 에이전트(컴퓨터-유즈 baseline) — hermes SSH 연결 태스크용.
// assay 의 command 하니스가 os-use env-container 안에서 `node /agent.cjs {{task}}` 로 실행한다(workDir=/tmp, DISPLAY=:99).
// 역할 = "행동"만: CDP(좌표 파악) + xdotool(실 OS 마우스/키보드)로 SSH 폼을 채우고 연결한다.
// 관측/채점은 에이전트가 아니라 assay 가 한다(OsUseEnvironment.snapshot 스크린샷 → VLM JudgeGrader). 관심사 분리.
// 실 BYO 에이전트(VLM 루프 등)는 같은 자리에 자기 프로그램을 둔다 — 이건 스크립트형 기준 에이전트.
const { chromium } = require("/app/node_modules/playwright");
const { execFileSync } = require("node:child_process");
const sh = (c) => execFileSync("bash", ["-lc", c], { encoding: "utf8" }).trim();
const shq = (c) => {
  try {
    return sh(c);
  } catch (e) {
    return String(e?.stdout || "");
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISPLAY = process.env.DISPLAY || ":99";

(async () => {
  const task = process.argv.slice(2).join(" ");
  console.error("[agent] task:", task);

  let browser = null;
  for (let i = 0; i < 45 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    } catch {
      await sleep(1000);
    }
  }
  if (!browser) throw new Error("CDP attach timeout (electron not on :9222)");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => /index\.html/.test(p.url())) || ctx.pages()[0];
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const dpr = await page.evaluate(() => window.devicePixelRatio);

  // hermes X 윈도우(가장 큰 가시 창)의 화면 원점 — CSS 박스 → 화면 px 변환용.
  let win = null;
  for (const id of shq(`DISPLAY=${DISPLAY} xdotool search --onlyvisible --name '.'`).split(/\s+/).filter(Boolean)) {
    try {
      const g = Object.fromEntries(
        sh(`DISPLAY=${DISPLAY} xdotool getwindowgeometry --shell ${id}`)
          .split("\n")
          .map((l) => l.split("=")),
      );
      const area = +g.WIDTH * +g.HEIGHT;
      if (+g.WIDTH > 300 && (!win || area > win.area)) win = { X: +g.X, Y: +g.Y, area };
    } catch {}
  }
  if (!win) throw new Error("no hermes window");

  const center = async (loc) => {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    if (!b) throw new Error("no bbox");
    return { x: Math.round(win.X + (b.x + b.width / 2) * dpr), y: Math.round(win.Y + (b.y + b.height / 2) * dpr) };
  };
  const click = async (loc) => {
    const c = await center(loc);
    sh(`DISPLAY=${DISPLAY} xdotool mousemove --sync ${c.x} ${c.y} click 1`);
    await sleep(400);
  };
  const type = async (loc, t) => {
    await click(loc);
    sh(`DISPLAY=${DISPLAY} xdotool type --clearmodifiers --delay 25 -- ${JSON.stringify(t)}`);
    await sleep(200);
  };

  // Welcome → SSH 패널 → 폼 작성(실 OS 키보드) → 연결.
  const sshBtn = page.getByRole("button", { name: /Connect via SSH/i });
  await sshBtn.waitFor({ timeout: 60000 });
  await click(sshBtn);
  const host = page.getByPlaceholder("192.168.1.100 or myserver.local");
  await host.waitFor({ timeout: 15000 });
  await type(host, "127.0.0.1");
  await type(page.getByPlaceholder("hermes"), "root");
  await type(page.getByPlaceholder("~/.ssh/id_rsa"), "/root/.ssh/id_rsa");
  await click(page.getByRole("button", { name: /Connect via SSH/i }));

  // 연결 성공 = 메인 UI 진입까지 대기(폼 이탈 → splash "Starting SSH tunnel…" → main). 메인 마커 'Ask anything'
  // 컴포저가 뜨면 끝. (실패 시 sshError 가 뜨면 중단 — 최종 화면을 assay 가 스냅샷+VLM 으로 채점한다.)
  const composer = page.getByPlaceholder("Ask anything");
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    if (await composer.isVisible().catch(() => false)) break;
    if (
      await page
        .locator(".welcome-remote-error")
        .isVisible()
        .catch(() => false)
    )
      break;
  }
  await sleep(1500); // 렌더 정착
  await browser.close();
  console.error("[agent] done");
})().catch((e) => {
  console.error("[agent] error", e?.stack || e);
  process.exit(1);
});
