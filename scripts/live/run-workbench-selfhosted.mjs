// Live e2e: the run workbench's SELF-HOSTED parity (S6) — the parked-request rendezvous round-trip with a REAL
// runner process. The control plane cannot exec into a runner's sandbox, so GET /runs/:id/fs parks a request;
// the runner's in-case servicing loop (runCase → poll_case_fs_requests / answer_case_fs_request over MCP)
// answers it from inside the case. This drill proves that whole loop over plain HTTP:
//   1) pair a workspace runner → start `everdict runner` with its token
//   2) register a slow-editor command harness (template + instance) and submit with runtime=self:ws
//   3) while it runs: GET /runs/:id/fs shows the live working tree (statuses) + /fs/file shows content+diff
//   4) the run settles succeeded
//
// Setup: api booted from source (in-memory, dev fallback auth) + `pnpm -F @everdict/cli build`.
// Usage: API=http://127.0.0.1:8792 node scripts/live/run-workbench-selfhosted.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const API = (process.env.API ?? "http://127.0.0.1:8792").replace(/\/$/, "");
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

// ① Pair a workspace runner and start the real runner CLI with its token.
const paired = await req("POST", "/workspace/runners", { label: "wb-drill", capabilities: ["git"] });
const token = paired.json?.token;
check("workspace runner paired", paired.status < 300 && Boolean(token), `${paired.status}`);
if (!token) process.exit(1);

const runner = spawn(
  process.execPath,
  ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", API, "--poll-interval-ms", "500"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
runner.stdout.on("data", (d) => process.stdout.write(`[runner] ${d}`));
runner.stderr.on("data", (d) => process.stdout.write(`[runner!] ${d}`));
const cleanup = () => {
  if (!runner.killed) runner.kill("SIGINT");
};
process.on("exit", cleanup);

try {
  await sleep(2500); // runner connects over MCP

  // ② Slow-editor command harness (template + instance) — edits the seeded repo, then idles so the drill can read it live.
  const stamp = Date.now().toString(36);
  const harnessId = `wb-self-${stamp}`;
  const command =
    'sh -c \'echo "print(1)" >> a.py && rm -f gone.txt && printf "def b():\\n    pass\\n" > b.py && sleep 40 && echo done\'';
  const template = await req("POST", "/harness-templates", {
    kind: "command",
    category: "live-drill",
    id: harnessId,
    version: "1.0.0",
    setup: [],
    command,
    trace: { kind: "none" },
  });
  check("harness template registered", template.status < 300, `${template.status}`);
  const instance = await req("POST", "/harnesses", {
    template: { id: harnessId, version: "1.0.0" },
    id: harnessId,
    version: "1.0.0",
  });
  check("harness instance registered", instance.status < 300, `${instance.status}`);

  const submitted = await req("POST", "/runs", {
    harness: { id: harnessId, version: "1.0.0" },
    runtime: "self:ws",
    case: {
      id: `wb-self-${stamp}`,
      env: { kind: "repo", source: { files: { "a.py": "print(0)\n", "gone.txt": "bye\n" } } },
      task: "edit the repo slowly",
      graders: [],
      timeoutSec: 180,
      tags: ["live", "workbench", "self-hosted"],
    },
  });
  const runId = submitted.json?.id;
  check("run submitted to self:ws", submitted.status < 300 && Boolean(runId), `${submitted.status} run=${runId}`);
  if (!runId) process.exit(1);

  // ③ S6 — the fs reads answer over the rendezvous while the case runs on the runner.
  let fsOut;
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const res = await req("GET", `/runs/${runId}/fs`);
      if (res.json?.found) {
        fsOut = res.json;
        break;
      }
      await sleep(3000);
    }
    const byPath = new Map((fsOut?.files ?? []).map((f) => [f.path, f.status]));
    check("S6 fs tree served over the parked-request rendezvous", Boolean(fsOut), JSON.stringify(fsOut?.files ?? []));
    check(
      "S6 statuses: a.py modified · b.py added · gone.txt deleted",
      byPath.get("a.py") === "modified" && byPath.get("b.py") === "added" && byPath.get("gone.txt") === "deleted",
      JSON.stringify([...byPath]),
    );
  }
  {
    const res = await req("GET", `/runs/${runId}/fs/file?path=a.py`);
    const f = res.json;
    check(
      "S6 fs file: content + working-tree diff served from inside the case",
      Boolean(f?.found) &&
        f.content.includes("print(0)") &&
        f.content.includes("print(1)") &&
        f.diff.includes("+print(1)"),
      `size=${f?.size}`,
    );
  }

  // ④ Settle.
  {
    let record;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const res = await req("GET", `/runs/${runId}`);
      record = res.json;
      if (record?.status === "succeeded" || record?.status === "failed") break;
      await sleep(4000);
    }
    check(
      "run settled succeeded on the self-hosted runner",
      record?.status === "succeeded",
      `status=${record?.status} error=${JSON.stringify(record?.error ?? null).slice(0, 160)}`,
    );
  }
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? "\n✅ PASS — run workbench self-hosted rendezvous live"
    : `\n❌ FAIL — ${failed.length} checks failed`,
);
process.exit(failed.length === 0 ? 0 : 1);
