// Live e2e: the browser-session lane's replay recording (S8) — a REAL interactive Chrome session streams its
// CDP environment plane into the durable recording (keyed evd-run-<sessionId>), scrubs live via peek, and
// seals at close. Setup: api from source with EVERDICT_BROWSER_SESSIONS=1 + a host Chrome binary.
// Usage: API=http://127.0.0.1:8793 node scripts/live/run-workbench-browser-session.mjs
import process from "node:process";

const API = (process.env.API ?? "http://127.0.0.1:8793").replace(/\/$/, "");
const HEADERS = { "content-type": "application/json", "x-everdict-tenant": "default" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const req = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: HEADERS,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
};

// ① Open a real interactive browser session.
const opened = await req("POST", "/browser-sessions", {});
const id = opened.json?.id;
check(
  "browser session opened",
  opened.status < 300 && Boolean(id),
  `${opened.status} id=${id ?? opened.text.slice(0, 160)}`,
);
if (!id) process.exit(1);

try {
  // ② While it lives: the recording's live tail (peek) fills with the CDP environment plane.
  let live;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const res = await req("GET", `/runs/${id}/recording`);
    const rec = res.json?.recording;
    const lanes = rec ? Object.values(rec.tracks ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0) : 0;
    if (res.json?.found && lanes >= 1) {
      live = { rec, lanes };
      break;
    }
    await sleep(3000);
  }
  check(
    "live recording tail fills while the session is open",
    Boolean(live),
    `lanes=${live?.lanes} kinds=${Object.keys(live?.rec?.tracks ?? {}).join(",")}`,
  );
  check("provisional envKind=live before seal", live?.rec?.envKind === "live", `envKind=${live?.rec?.envKind}`);
} finally {
  // ③ Close → the ledger settles and the recording seals as a browser recording.
  const closed = await req("DELETE", `/browser-sessions/${id}`);
  check("session closed", closed.status < 300 || closed.status === 204, `${closed.status}`);
}
await sleep(1500);
{
  const run = await req("GET", `/runs/${id}`);
  check("session run settled in the ledger", run.json?.status === "succeeded", `status=${run.json?.status}`);
  const res = await req("GET", `/runs/${id}/recording`);
  const rec = res.json?.recording;
  check(
    "sealed browser recording survives the close",
    Boolean(rec) && rec.envKind === "browser",
    `envKind=${rec?.envKind} lanes=${Object.keys(rec?.tracks ?? {}).join(",")}`,
  );
}
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0 ? "\n✅ PASS — browser-session lane records + seals live" : `\n❌ FAIL — ${failed.length}`,
);
process.exit(failed.length === 0 ? 0 : 1);
