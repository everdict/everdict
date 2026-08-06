// Live e2e: the multiplexed live SSE (④) — ONE connection carries a running case's status/trace/fs lanes as
// change-only deltas, then `event: end` at settle. Runs a slow-editor command harness on a real Nomad alloc
// and consumes GET /runs/:id/live/stream?lanes=trace,fs while it executes.
// Setup: nomad agent -dev + everdict-job-runner:slim + api from source. Usage: API=http://127.0.0.1:8794 node scripts/live/run-live-stream.mjs
import process from "node:process";

const API = (process.env.API ?? "http://127.0.0.1:8794").replace(/\/$/, "");
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

const stamp = Date.now().toString(36);
const runtimeId = `sse-nomad-${stamp}`;
const harnessId = `sse-editor-${stamp}`;
await req("POST", "/runtimes", {
  kind: "nomad",
  id: runtimeId,
  version: "1.0.0",
  addr: "http://127.0.0.1:4646",
  image: "everdict-job-runner:slim",
  tags: [],
});
await req("POST", "/harness-templates", {
  kind: "command",
  category: "live-drill",
  id: harnessId,
  version: "1.0.0",
  setup: [],
  command: "sh -c 'echo \"print(1)\" >> a.py && sleep 25 && echo done'",
  trace: { kind: "none" },
});
await req("POST", "/harnesses", { template: { id: harnessId, version: "1.0.0" }, id: harnessId, version: "1.0.0" });
const submitted = await req("POST", "/runs", {
  harness: { id: harnessId, version: "1.0.0" },
  runtime: runtimeId,
  case: {
    id: `sse-${stamp}`,
    env: { kind: "repo", source: { files: { "a.py": "print(0)\n" } } },
    task: "edit",
    graders: [],
    timeoutSec: 120,
    tags: ["live"],
  },
});
const runId = submitted.json?.id;
check("run submitted", Boolean(runId), `run=${runId}`);
if (!runId) process.exit(1);

// Attach ONE stream and tally what arrives until `end` (or a 3-minute guard).
const events = { status: 0, trace: 0, fs: 0, end: 0 };
let endStatus;
let fsPayload;
const res = await fetch(`${API}/runs/${runId}/live/stream?lanes=trace,fs`, { headers: HEADERS });
check(
  "stream attached (200, event-stream)",
  res.ok && (res.headers.get("content-type") ?? "").includes("event-stream"),
  `${res.status}`,
);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
const guard = setTimeout(() => reader.cancel().catch(() => {}), 180_000);
for (;;) {
  const { done, value } = await reader.read().catch(() => ({ done: true }));
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  for (;;) {
    const at = buf.indexOf("\n\n");
    if (at < 0) break;
    const chunk = buf.slice(0, at);
    buf = buf.slice(at + 2);
    const ev = /^event: (\w+)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (!ev) continue;
    events[ev] = (events[ev] ?? 0) + 1;
    if (ev === "fs" && data) fsPayload = JSON.parse(data);
    if (ev === "end" && data) endStatus = JSON.parse(data).status;
  }
  if (events.end > 0) break;
}
clearTimeout(guard);
check("trace lane delivered dispatch marks", events.trace >= 1, `trace batches=${events.trace}`);
check(
  "fs lane delivered the live working tree",
  events.fs >= 1 && Boolean(fsPayload?.files?.some((f) => f.path === "a.py")),
  `fs pushes=${events.fs} files=${JSON.stringify(fsPayload?.files ?? [])}`,
);
check(
  "stream closed itself with event: end at settle",
  events.end === 1 && endStatus === "succeeded",
  `end=${endStatus}`,
);

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "\n✅ PASS — multiplexed live SSE end-to-end" : `\n❌ FAIL — ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
