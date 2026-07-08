// live: trace sink export to real Langfuse (v2) — verifies both modes in docs/architecture/trace-sink.md.
//   create (flow ①): LangfuseTraceSink batch-ingests trace+observations and scores as score-create events.
//   attach (flow ②): score events only onto an existing trace id — no new trace.
//   round-trip: read back via the public API (traces/scores) + LangfuseTraceSource.fetch normalization.
//
// Setup: docker (the script boots/tears down langfuse/langfuse:2 + postgres:16-alpine on a private network,
// headless-init keys). For an existing server: LANGFUSE_ENDPOINT + LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY.
// Usage: node scripts/live/trace-sink-langfuse.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { buildTraceSink, buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NET = "everdict-lf-net";
const PG = "everdict-lf-pg";
const LF = "everdict-lf";
const PK = process.env.LANGFUSE_PUBLIC_KEY ?? "pk-lf-e2e";
const SK = process.env.LANGFUSE_SECRET_KEY ?? "sk-lf-e2e";
let bootedDocker = false;
let ENDPOINT = process.env.LANGFUSE_ENDPOINT ?? "";

const auth = `Basic ${Buffer.from(`${PK}:${SK}`).toString("base64")}`;
const api = async (path) => {
  const res = await fetch(`${ENDPOINT}${path}`, { headers: { authorization: auth } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
async function healthy() {
  try {
    return (await fetch(`${ENDPOINT}/api/public/health`)).ok;
  } catch {
    return false;
  }
}

if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:3111";
  console.log(`Langfuse v2 boot (docker) → ${ENDPOINT}`);
  execFileSync("docker", ["network", "create", NET], { stdio: "ignore" });
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", PG, "--network", NET,
    "-e", "POSTGRES_PASSWORD=lf", "-e", "POSTGRES_DB=langfuse",
    "postgres:16-alpine",
  ]);
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", LF, "--network", NET, "-p", "3111:3000",
    "-e", `DATABASE_URL=postgresql://postgres:lf@${PG}:5432/langfuse`,
    "-e", "NEXTAUTH_SECRET=e2e-secret", "-e", "SALT=e2e-salt", "-e", "NEXTAUTH_URL=http://127.0.0.1:3111",
    "-e", "LANGFUSE_INIT_ORG_ID=e2e-org", "-e", "LANGFUSE_INIT_ORG_NAME=e2e",
    "-e", "LANGFUSE_INIT_PROJECT_ID=e2e-proj", "-e", "LANGFUSE_INIT_PROJECT_NAME=e2e",
    "-e", `LANGFUSE_INIT_PROJECT_PUBLIC_KEY=${PK}`, "-e", `LANGFUSE_INIT_PROJECT_SECRET_KEY=${SK}`,
    "-e", "LANGFUSE_INIT_USER_EMAIL=e2e@example.com", "-e", "LANGFUSE_INIT_USER_NAME=e2e",
    "-e", "LANGFUSE_INIT_USER_PASSWORD=e2e-password-123",
    "langfuse/langfuse:2",
  ]);
  bootedDocker = true;
}
for (let i = 0; i < 120 && !(await healthy()); i++) await sleep(2000);
if (!(await healthy())) throw new Error("Langfuse did not come up");
console.log("Langfuse ready\n");

try {
  const ctx = { scorecardId: "sc-live-lf", dataset: "d@1.0.0", harness: "h@1" };
  const mkCase = (caseId) => ({
    caseId,
    trace: [
      { t: 0, kind: "message", role: "user", text: `${caseId} task instruction` },
      {
        t: 10,
        kind: "llm_call",
        model: "gpt-5.4-mini",
        cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
        latencyMs: 5,
      },
      { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
      { t: 30, kind: "tool_result", id: "t1", ok: true, output: "done" },
      { t: 40, kind: "message", role: "assistant", text: "done" },
    ],
    scores: [
      { name: "tests_pass", value: 1, pass: true },
      { name: "judge:quality", value: 0.8, comment: "sufficient evidence" },
    ],
  });

  // 1) create mode — two cases through batch ingestion.
  const sink = buildTraceSink({ kind: "langfuse", endpoint: ENDPOINT, auth });
  const created = await sink.export(ctx, [mkCase("c1"), mkCase("c2")]);
  for (const c of created.cases) {
    if (c.error) throw new Error(`✗ create failed (${c.caseId}): ${c.error}`);
    console.log(`create: ${c.caseId} → ${c.externalId}`);
  }

  // 2) verify server-side — ingestion is async: poll until both traces + their scores land.
  const t1 = created.cases[0].externalId;
  let traces = [];
  let scores = [];
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    traces = (await api("/api/public/traces?limit=50")).data ?? [];
    scores = (await api("/api/public/scores?limit=50")).data ?? [];
    if (traces.length >= 2 && scores.length >= 4) break;
  }
  if (traces.length < 2) throw new Error(`✗ expected 2 traces, got ${traces.length}`);
  const scoreNames = new Set(scores.map((s) => s.name));
  if (!scoreNames.has("tests_pass") || !scoreNames.has("judge:quality"))
    throw new Error(`✗ scores missing: ${JSON.stringify([...scoreNames])}`);
  console.log(`✓ create: ${traces.length} traces, scores = ${JSON.stringify([...scoreNames])}`);

  // 3) attach mode — a score event only, onto the existing trace; trace count must not grow.
  const attached = await sink.export(ctx, [
    { caseId: "c1", trace: [], scores: [{ name: "judge:safety", value: 1, pass: true }], externalId: t1 },
  ]);
  if (attached.cases[0]?.error) throw new Error(`✗ attach failed: ${attached.cases[0].error}`);
  if (attached.cases[0]?.externalId !== t1) throw new Error("✗ attach must keep the original trace id");
  let afterScores = [];
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    afterScores = (await api(`/api/public/scores?limit=50`)).data ?? [];
    if (afterScores.some((s) => s.name === "judge:safety")) break;
  }
  const afterTraces = (await api("/api/public/traces?limit=50")).data ?? [];
  if (!afterScores.some((s) => s.name === "judge:safety" && s.traceId === t1))
    throw new Error("✗ judge:safety did not attach to the original trace");
  if (afterTraces.length !== traces.length)
    throw new Error(`✗ attach duplicated traces: ${traces.length} → ${afterTraces.length}`);
  console.log(`✓ attach: judge:safety onto ${t1} — trace count stable (${traces.length})`);

  // 4) round-trip — normalize back through the pull source.
  const source = buildTraceSource({ kind: "langfuse", endpoint: ENDPOINT, auth });
  const events = await source.fetch(t1);
  const llm = events.find((e) => e.kind === "llm_call");
  if (!llm || llm.model !== "gpt-5.4-mini")
    throw new Error(`✗ round-trip normalization mismatch: ${JSON.stringify(events).slice(0, 300)}`);
  console.log(`✓ round-trip: ${events.length} events normalized back (llm_call model matches)`);

  console.log(
    "\n✅ trace-sink live e2e PASS — verified both modes against real Langfuse v2: create (ingestion batch) and attach (score events only, no duplicate trace).",
  );
} finally {
  if (bootedDocker) {
    execFileSync("docker", ["rm", "-f", LF], { stdio: "ignore" });
    execFileSync("docker", ["rm", "-f", PG], { stdio: "ignore" });
    execFileSync("docker", ["network", "rm", NET], { stdio: "ignore" });
  }
}
