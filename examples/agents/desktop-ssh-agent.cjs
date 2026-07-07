// Reference desktop agent (computer-use baseline) — for the hermes SSH connection task.
// The everdict command harness runs it inside an os-use env-container as `node /agent.cjs {{task}}` (workDir=/tmp, DISPLAY=:99).
// Its role is "action" only: fill in the SSH form and connect via CDP (to find coordinates) + xdotool (the real OS mouse/keyboard).
// Observation/scoring is done by everdict, not the agent (OsUseEnvironment.snapshot screenshot → VLM JudgeGrader). Separation of concerns.
// A real BYO agent (a VLM loop, etc.) puts its own program in the same place — this is a scripted reference agent.
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

  // Screen origin of the hermes X window (the largest visible window) — for converting the CSS box → screen px.
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

  // Welcome → SSH panel → fill in the form (real OS keyboard) → connect.
  const sshBtn = page.getByRole("button", { name: /Connect via SSH/i });
  await sshBtn.waitFor({ timeout: 60000 });
  await click(sshBtn);
  const host = page.getByPlaceholder("192.168.1.100 or myserver.local");
  await host.waitFor({ timeout: 15000 });
  await type(host, "127.0.0.1");
  await type(page.getByPlaceholder("hermes"), "root");
  await type(page.getByPlaceholder("~/.ssh/id_rsa"), "/root/.ssh/id_rsa");
  await click(page.getByRole("button", { name: /Connect via SSH/i }));

  // Connection success = wait until the main UI appears (leave the form → splash "Starting SSH tunnel…" → main). Done when the
  // main-marker 'Ask anything' composer shows. (On failure, stop when sshError appears — everdict scores the final screen via snapshot+VLM.)
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
  await sleep(1500); // let the render settle
  await browser.close();
  console.error("[agent] done");
})().catch((e) => {
  console.error("[agent] error", e?.stack || e);
  process.exit(1);
});
