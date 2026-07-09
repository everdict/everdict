// S0 proof — an interactive live browser session over CDP: real screencast frames OUT + real input IN.
// Launches a real Chrome (google-chrome, headless), drives it via @everdict/topology's openBrowserSession, and:
//   default        → self-check: assert screencast frames stream AND typed input reaches the real DOM (proof).
//   --serve [port] → serves a canvas page (SSE frames + POST input) so YOU drive the real browser in your browser.
//
//   node scripts/live/interactive-browser.mjs            # headless proof (run anywhere with google-chrome)
//   node scripts/live/interactive-browser.mjs --serve    # then open http://localhost:7900 and drive it
//
// Requires: a chrome binary (google-chrome / chromium) on PATH. Build topology first: pnpm --filter @everdict/topology build
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowserSession } from "../../packages/topology/dist/index.js";

const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const PORT = 9222 + Math.floor(process.uptime() * 7) % 200; // avoid clashes across runs (no Math.random policy is fine here — a script)
const CDP = `http://127.0.0.1:${PORT}`;

function launchChrome() {
  const bin = CHROME.find((b) => {
    try {
      return spawn(b, ["--version"]) && b;
    } catch {
      return false;
    }
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "evd-cdp-"));
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--window-size=1024,768",
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  const proc = spawn(bin ?? "google-chrome", args, { stdio: "ignore" });
  return proc;
}

async function waitCdp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${CDP}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("chrome CDP did not come up");
}

// Raw CDP Runtime.evaluate (independent of the session) — used by the self-check to read the real DOM back.
async function rawEval(expression) {
  const targets = await (await fetch(`${CDP}/json`)).json();
  const wsUrl = (targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl))?.webSocketDebuggerUrl;
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { ws.close(); reject(new Error("eval timeout")); }, 5000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== 1) return;
      clearTimeout(t); ws.close();
      m.error ? reject(new Error(m.error.message)) : resolve(m.result?.result?.value);
    });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("eval ws error")); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPED = "everdict-login-ok";

async function selfCheck(session) {
  let frames = 0;
  session.onFrame(() => { frames += 1; });
  // A page with a text input we can type into.
  session.navigate("data:text/html,<body style='margin:0'><input id=q autofocus style='font-size:40px;width:95%25;margin-top:20px'>");
  await sleep(1500); // load + let the screencast stream a few frames

  // INPUT IN: click the field to focus, then type each char as a CDP char event.
  session.mouse({ type: "mousePressed", x: 120, y: 45, button: "left", clickCount: 1 });
  session.mouse({ type: "mouseReleased", x: 120, y: 45, button: "left", clickCount: 1 });
  for (const ch of TYPED) session.key({ type: "char", text: ch });
  await sleep(600);

  const value = await rawEval("document.querySelector('#q') && document.querySelector('#q').value");
  const ok = frames > 0 && value === TYPED;
  console.log(`\n  screencast frames received : ${frames}   ${frames > 0 ? "✅ (frames stream OUT)" : "❌"}`);
  console.log(`  typed via CDP → real DOM   : ${JSON.stringify(value)}   ${value === TYPED ? "✅ (input reaches IN)" : "❌ expected " + JSON.stringify(TYPED)}`);
  console.log(`\n  ${ok ? "PASS — interactive live browser session works end-to-end (frames out + input in + navigate)." : "FAIL"}\n`);
  return ok;
}

// --serve: a canvas page (SSE frames + POST input/navigate) so a human drives the real browser.
function serve(session, port) {
  const clients = new Set();
  session.onFrame((f) => {
    const line = `data:${JSON.stringify({ data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight })}\n\n`;
    for (const res of clients) res.write(line);
  });
  const page = `<!doctype html><meta charset=utf8><title>everdict — interactive browser</title>
<style>body{margin:0;background:#111;font:14px system-ui;color:#ccc}#bar{display:flex;gap:6px;padding:6px}#u{flex:1;padding:6px}canvas{display:block;background:#000;max-width:100%25}</style>
<div id=bar><input id=u placeholder="https://… (Enter to go)" style="color:#111"><button onclick="go()">Go</button><span id=s>connecting…</span></div>
<canvas id=c width=1024 height=768 tabindex=0></canvas>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');let W=1024,H=768;
const es=new EventSource('/frames');es.onmessage=e=>{const f=JSON.parse(e.data);W=f.w;H=f.h;const img=new Image();img.onload=()=>{c.width=W;c.height=H;x.drawImage(img,0,0)};img.src='data:image/jpeg;base64,'+f.data;document.getElementById('s').textContent='live'};
const P=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
const XY=e=>{const r=c.getBoundingClientRect();return{x:(e.clientX-r.left)*W/r.width,y:(e.clientY-r.top)*H/r.height}};
c.addEventListener('mousedown',e=>{const p=XY(e);P('/input',{kind:'mouse',type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});c.focus()});
c.addEventListener('mouseup',e=>{const p=XY(e);P('/input',{kind:'mouse',type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1})});
c.addEventListener('mousemove',e=>{const p=XY(e);P('/input',{kind:'mouse',type:'mouseMoved',x:p.x,y:p.y})});
c.addEventListener('keydown',e=>{if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){P('/input',{kind:'key',type:'char',text:e.key})}else{P('/input',{kind:'key',type:'keyDown',key:e.key,code:e.code})}e.preventDefault()});
function go(){P('/navigate',{url:document.getElementById('u').value})}
document.getElementById('u').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
</script>`;
  const srv = http.createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
    if (req.url === "/frames") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (req.method === "POST") {
      let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => {
        const b = JSON.parse(body || "{}");
        if (req.url === "/navigate") session.navigate(b.url);
        else if (req.url === "/input") { const { kind, ...rest } = b; kind === "mouse" ? session.mouse(rest) : session.key(rest); }
        res.writeHead(204); res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  srv.listen(port, () => console.log(`\n  ▶ open http://localhost:${port} and drive the real browser (navigate, click, type, log in). Ctrl-C to stop.\n`));
}

async function main() {
  const serveMode = process.argv.includes("--serve");
  const port = Number(process.argv[process.argv.indexOf("--serve") + 1]) || 7900;
  const chrome = launchChrome();
  let ok = false;
  try {
    const ver = await waitCdp();
    console.log(`  chrome up: ${ver.Browser}  (CDP ${CDP})`);
    const session = await openBrowserSession(CDP, { screencast: { format: "jpeg", quality: 60, everyNthFrame: 1 } });
    if (serveMode) {
      serve(session, port);
      await new Promise(() => {}); // run until Ctrl-C
    } else {
      ok = await selfCheck(session);
      session.close();
    }
  } finally {
    if (!serveMode) { try { chrome.kill("SIGKILL"); } catch {} }
  }
  if (!serveMode) process.exit(ok ? 0 : 1);
}

process.on("SIGINT", () => process.exit(0));
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
