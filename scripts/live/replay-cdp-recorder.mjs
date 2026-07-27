// Live verification of the browser environment-plane recorder (replay ②) against a real Chrome/CDP.
//
// What it proves that the unit test (fake socket) can't: the recorder, over a REAL CDP WebSocket, actually receives and
// maps Chrome's own Network / Runtime.console / Page.frameNavigated events into replay tracks while a page loads.
//
// Setup: a Chrome with `--remote-debugging-port=9222` (the dev browser-sessions Chrome already runs there). It creates a
// DEDICATED throwaway tab, scopes the recorder to that tab (so the user's other tabs are untouched), drives a navigation
// that logs to the console and fires a fetch, asserts the three lanes were captured, then closes the tab.
//
//   CDP_BASE=http://127.0.0.1:9222 node scripts/live/replay-cdp-recorder.mjs
//
// Requires `pnpm -F @everdict/topology build` first (imports the compiled dist).

import { CdpEnvironmentRecorder } from "../../packages/topology/dist/index.js";

const CDP_BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) A dedicated tab so we never touch the user's real pages.
  const created = await fetch(`${CDP_BASE}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const tabId = created.id;
  const wsUrl = created.webSocketDebuggerUrl;
  console.log(`▶ created tab ${tabId} (${wsUrl})`);

  // 2) Scope the recorder's target discovery to ONLY this tab via an injected fetch (real WebSocket transport, precise
  //    target). Everything else about the recorder is the production path.
  const scopedFetch = async (url, init) =>
    String(url).endsWith("/json")
      ? { ok: true, status: 200, json: async () => [{ type: "page", webSocketDebuggerUrl: wsUrl }] }
      : fetch(url, init);

  const tracks = [];
  const frames = [];
  const recorder = new CdpEnvironmentRecorder(
    CDP_BASE,
    { track: (item) => tracks.push(item), frame: (f) => frames.push(f) },
    { fetch: scopedFetch, frames: true, frameThrottleMs: 300 },
  );
  await recorder.start();
  console.log("▶ recorder attached — subscribing to Network/Runtime/Page");
  await sleep(300); // let the enable commands land before we drive

  // 3) Drive the tab over a separate control connection: navigate to a page that logs to the console and fetches a
  //    local resource (a real network round-trip to the CDP HTTP server itself — no internet needed).
  const ctrl = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ctrl.addEventListener("open", resolve, { once: true });
    ctrl.addEventListener("error", reject, { once: true });
  });
  let cid = 0;
  const drive = (method, params = {}) => ctrl.send(JSON.stringify({ id: ++cid, method, params }));
  const page = `data:text/html,${encodeURIComponent(
    `<html><body>replay probe<script>console.log("replay-cdp-probe");fetch("${CDP_BASE}/json/version").then(()=>console.warn("fetch-ok")).catch((e)=>console.error("fetch-err",e))</script></body></html>`,
  )}`;
  drive("Page.enable");
  drive("Page.navigate", { url: page });
  console.log("▶ drove Page.navigate → data URL (console.log + fetch)");

  // 4) Poll until all three lanes appear (or time out).
  const has = (t) => tracks.some((x) => x.track === t);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(has("nav") && has("console") && has("network"))) await sleep(200);

  recorder.stop();
  try {
    ctrl.close();
  } catch {}
  await fetch(`${CDP_BASE}/json/close/${tabId}`).catch(() => {});

  // 5) Report + assert.
  const byLane = (t) => tracks.filter((x) => x.track === t).map((x) => x.entry);
  console.log("\n── captured tracks ──");
  console.log(
    `nav      (${byLane("nav").length}):`,
    byLane("nav").map((e) => e.url.slice(0, 60)),
  );
  console.log(
    `console  (${byLane("console").length}):`,
    byLane("console").map((e) => `${e.level}:${e.text}`.slice(0, 60)),
  );
  console.log(
    `network  (${byLane("network").length}):`,
    byLane("network")
      .slice(0, 5)
      .map((e) => `${e.method} ${e.url.slice(0, 40)} → ${e.status ?? "-"} (${e.ms}ms)`),
  );
  console.log(`frames   (${frames.length})`);

  const missing = ["nav", "console", "network"].filter((t) => !has(t));
  if (missing.length) {
    console.error(`\n✗ FAIL — missing lanes: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `\n✅ PASS — recorder captured nav + console + network (and ${frames.length} frame(s)) over a real CDP socket.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("✗ error:", e);
  process.exit(1);
});
