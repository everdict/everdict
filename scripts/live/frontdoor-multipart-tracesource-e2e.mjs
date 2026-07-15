// Live e2e for the two Suna-exposed fixes, end to end over the WIRE + real MLflow 3.14:
//   G2 — front-door multipart + attachments: the ServiceTopologyBackend submits `request.encoding:"form"` + `files`
//        to a REAL http front-door server; we assert the server RECEIVED a multipart body with the prompt text part
//        AND the file part (the attachment content resolved from the case env). No mocked submit — the default
//        HttpFrontDoorDriver encodes and sends it for real (stream completion).
//   G1 — inline 5-kind trace source: the topology's INLINE trace source is an MLflow source with correlate:"tag";
//        after the run, everdict pulls that case's trace from real MLflow by the everdict.run_id tag and grades it.
//
// Prereq: docker (boots ghcr.io/mlflow/mlflow:v3.14.0, no auth, sqlite). Set MLFLOW_ENDPOINT to reuse a server.
// Usage: node scripts/live/frontdoor-multipart-tracesource-e2e.mjs
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import process from "node:process";
import { stepsGrader } from "../../packages/graders/dist/index.js";
import { costGrader } from "../../packages/graders/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { buildTraceSink, buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-frontdoor-e2e-mlflow";
let bootedDocker = false;
let ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "";
const assert = (c, l) => {
  if (!c) throw new Error(`✗ ${l}`);
  console.log(`✓ ${l}`);
};
const up = async (u) => {
  try {
    return (await fetch(`${u}/version`)).ok;
  } catch {
    return false;
  }
};

// --- 0) real MLflow ---
if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:5509";
  console.log(`MLflow boot (docker, v3.14.0) → ${ENDPOINT}`);
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "5509:5000",
    "ghcr.io/mlflow/mlflow:v3.14.0",
    "mlflow",
    "server",
    "--host",
    "0.0.0.0",
    "--port",
    "5000",
    "--backend-store-uri",
    "sqlite:////tmp/mlflow-fd.db",
  ]);
  bootedDocker = true;
}
for (let i = 0; i < 60 && !(await up(ENDPOINT)); i++) await sleep(1000);
if (!(await up(ENDPOINT))) throw new Error(`MLflow did not come up: ${ENDPOINT}`);
console.log(`MLflow up: ${ENDPOINT}`);
const api = async (path, init = {}) => {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

// --- tiny multipart parser (enough to extract name/filename/content per part) ---
function parseMultipart(buf, contentType) {
  const m = /boundary=(.+)$/.exec(contentType ?? "");
  if (!m) return { fields: {}, files: {} };
  const boundary = `--${m[1]}`;
  const parts = buf.toString("latin1").split(boundary).slice(1, -1);
  const fields = {};
  const files = {};
  for (const p of parts) {
    const idx = p.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    const head = p.slice(0, idx);
    const body = p.slice(idx + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]+)"/.exec(head)?.[1];
    if (!name) continue;
    if (filename) files[name] = { filename, content: Buffer.from(body, "latin1").toString("utf8") };
    else fields[name] = Buffer.from(body, "latin1").toString("utf8");
  }
  return { fields, files };
}

let received; // what the front-door server actually got
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received = {
      contentType: req.headers["content-type"],
      ...parseMultipart(Buffer.concat(chunks), req.headers["content-type"]),
    };
    // stream completion: emit one SSE event that matches done {field:"status", equals:"completed"}
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"status":"completed"}\n\n');
    res.end();
  });
});

try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const agentUrl = `http://127.0.0.1:${port}`;

  // --- 1) seed a trace the "deployed agent" emitted + TAG it everdict.run_id ---
  const { experiment_id: experimentId } = await api("/api/2.0/mlflow/experiments/create", {
    method: "POST",
    body: JSON.stringify({ name: `everdict-fd-e2e-${Date.now()}` }),
  });
  const sink = buildTraceSink({ kind: "mlflow", endpoint: ENDPOINT, project: experimentId });
  const runId = `evd-fd-${Date.now().toString(36)}`;
  const seeded = await sink.export({ scorecardId: "sc", dataset: "d@1", harness: "h@1" }, [
    {
      caseId: "seed",
      trace: [
        { t: 0, kind: "message", role: "user", text: "task" },
        {
          t: 10,
          kind: "llm_call",
          model: "gpt-5.4-mini",
          cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
          latencyMs: 5,
        },
        { t: 20, kind: "tool_call", id: "t1", name: "browser.navigate", args: {} },
      ],
      scores: [],
    },
  ]);
  if (seeded.cases[0]?.error) throw new Error(`seed failed: ${seeded.cases[0].error}`);
  await api(`/api/3.0/mlflow/traces/${seeded.cases[0].externalId}/tags`, {
    method: "PATCH",
    body: JSON.stringify({ key: "everdict.run_id", value: runId }),
  });
  const probe = buildTraceSource({ kind: "mlflow", endpoint: ENDPOINT });
  for (let i = 0; i < 20; i++) {
    if ((await probe.fetch(seeded.cases[0].externalId).catch(() => [])).some((e) => e.kind === "llm_call")) break;
    await sleep(1000);
  }

  // --- 2) drive a case through ServiceTopologyBackend: G2 multipart submit + G1 inline mlflow(tag) trace source ---
  const spec = {
    kind: "service",
    id: "fd-agent",
    version: "1.0.0",
    services: [{ name: "agent", image: "agent:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }], // → {{thread_id}} in the wiring
    frontDoor: {
      service: "agent",
      submit: "POST /run",
      request: {
        encoding: "form", // G2
        bodyTemplate: { prompt: "{{task}}", thread_id: "{{thread_id}}" },
        files: [{ field: "file", from: "input.csv" }], // resolved from the case env
      },
      completion: { mode: "stream", done: { field: "status", equals: "completed" }, timeoutMs: 15000 },
    },
    traceSource: { kind: "mlflow", endpoint: ENDPOINT },
  };
  const backend = new ServiceTopologyBackend({
    runtime: {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { agent: agentUrl } };
      },
    },
    // G1: the INLINE mlflow source with correlate:"tag" (the widened config the topology pulls from).
    traceSource: buildTraceSource({
      kind: "mlflow",
      endpoint: ENDPOINT,
      correlate: "tag",
      project: String(experimentId),
    }),
    specFor: () => spec,
    graders: [stepsGrader, costGrader],
    newRunId: () => runId,
  });

  const CSV = "col_a,col_b\n1,2\n3,4";
  const job = {
    tenant: "acme",
    harness: { id: "fd-agent", version: "1.0.0" },
    runId,
    evalCase: {
      id: "c1",
      env: { kind: "repo", source: { files: { "input.csv": CSV } } },
      task: "summarize the attached csv",
      graders: [],
      timeoutSec: 60,
      tags: [],
    },
  };

  console.log("\n=== dispatch: multipart submit over the wire → pull from MLflow by tag → grade ===");
  const r = await backend.dispatch(job);

  // G2 — the server actually received a multipart body with the prompt part + the attachment content.
  assert(
    /multipart\/form-data/.test(received?.contentType ?? ""),
    "G2 front-door received multipart/form-data (not JSON)",
  );
  assert(received?.fields?.prompt === "summarize the attached csv", "G2 the prompt text part arrived");
  assert(received?.fields?.thread_id?.startsWith("run-"), "G2 the thread_id text part arrived");
  assert(received?.files?.file?.filename === "input.csv", "G2 the file part arrived with filename=input.csv");
  assert(
    received?.files?.file?.content === CSV,
    "G2 the attachment CONTENT (resolved from the case env) arrived intact",
  );

  // G1 — the inline mlflow(tag) source pulled this run's trace after completion, and the graders scored it.
  const llm = r.trace.find((e) => e.kind === "llm_call");
  assert(
    llm?.model === "gpt-5.4-mini" && llm?.cost?.inputTokens === 42,
    "G1 inline mlflow source pulled the trace via TAG correlation (llm_call 42/7)",
  );
  const steps = r.scores.find((s) => s.graderId === "steps");
  const cost = r.scores.find((s) => s.graderId === "cost");
  assert((steps?.value ?? 0) > 0, `G1 steps grader scored the pulled trace (${steps?.value})`);
  assert(Math.abs((cost?.value ?? 0) - 0.01) < 1e-9, `G1 cost grader scored the pulled cost (${cost?.value})`);

  console.log(
    "\n\x1b[32m✅ e2e PASS — G2: multipart front-door delivered the prompt + the attachment over the wire; G1: the inline MLflow trace source pulled the run's trace by tag and graded it.\x1b[0m",
  );
} finally {
  server.close();
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker cleanup done)");
    } catch {}
  }
}
