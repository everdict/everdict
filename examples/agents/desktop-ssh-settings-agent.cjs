// 레퍼런스 데스크탑 에이전트 #2 — desktop-ssh-agent 보다 유능(task-aware). SSH 로 연결한 뒤, 태스크가 Settings 를
// 요구하면 사이드바 Settings 로 내비게이션까지 한다. 같은 데이터셋을 agent #1(SSH 만) vs #2 로 돌려 diffScorecards 로
// 하니스 A/B 비교를 실증하기 위한 두 번째 하니스. command 하니스가 `node /agent-settings.cjs {{task}}` 로 실행.
// 행동만 — 관측/채점은 assay(OsUseEnvironment.snapshot + VLM JudgeGrader).
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
  console.error("[agent2] task:", task);

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

  // 1) SSH 연결(agent #1 과 동일).
  const sshBtn = page.getByRole("button", { name: /Connect via SSH/i });
  await sshBtn.waitFor({ timeout: 60000 });
  await click(sshBtn);
  const host = page.getByPlaceholder("192.168.1.100 or myserver.local");
  await host.waitFor({ timeout: 15000 });
  await type(host, "127.0.0.1");
  await type(page.getByPlaceholder("hermes"), "root");
  await type(page.getByPlaceholder("~/.ssh/id_rsa"), "/root/.ssh/id_rsa");
  await click(page.getByRole("button", { name: /Connect via SSH/i }));

  // 2) 메인 UI 진입 대기.
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
  await sleep(1000);

  // 3) task-aware: Settings 를 요구하면 모달 닫고 사이드바 Settings 로 내비게이션(agent #1 은 안 함).
  if (/settings/i.test(task)) {
    const notNow = page.getByText("Not Now", { exact: false });
    if (await notNow.isVisible().catch(() => false)) await click(notNow).catch(() => {});
    const settings = page.getByText("Settings", { exact: true }).first();
    await settings.waitFor({ timeout: 10000 }).catch(() => {});
    if (await settings.isVisible().catch(() => false)) await click(settings).catch(() => {});
    await sleep(2500); // Settings 페이지 렌더 정착
  }

  await browser.close();
  console.error("[agent2] done");
})().catch((e) => {
  console.error("[agent2] error", e?.stack || e);
  process.exit(1);
});
