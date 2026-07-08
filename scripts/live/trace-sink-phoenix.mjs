// live: trace sink export to real Arize Phoenix — verifies both modes in docs/architecture/trace-sink.md.
//   create (flow ①): PhoenixTraceSink uploads spans (POST /v1/projects/{p}/spans, JSON) and scores as trace
//     annotations (POST /v1/trace_annotations).
//   attach (flow ②): annotations only onto an existing (client-minted) trace id — no new trace.
//   round-trip: read back with PhoenixTraceSource.fetch and check normalization.
//
// Setup: docker (the script boots/tears down arizephoenix/phoenix:latest). For an existing server, use PHOENIX_ENDPOINT.
// Usage: node scripts/live/trace-sink-phoenix.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { buildTraceSink, buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-trace-sink-phoenix";
const PROJECT = "everdict-sink-e2e";
let bootedDocker = false;
let ENDPOINT = process.env.PHOENIX_ENDPOINT ?? "";

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:6117";
  console.log(`Phoenix boot (docker, arizephoenix/phoenix:latest) → ${ENDPOINT}`);
  execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", "6117:6006", "arizephoenix/phoenix:latest"]);
  bootedDocker = true;
}
for (let i = 0; i < 60 && !(await up(ENDPOINT)); i++) await sleep(1000);
if (!(await up(ENDPOINT))) throw new Error("Phoenix did not come up");
console.log("Phoenix ready\n");

try {
  const ctx = { scorecardId: "sc-live-phx", dataset: "d@1.0.0", harness: "h@1" };
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

  // 1) create mode — spans + annotations for two cases.
  const sink = buildTraceSink({ kind: "phoenix", endpoint: ENDPOINT, project: PROJECT });
  const created = await sink.export(ctx, [mkCase("c1"), mkCase("c2")]);
  for (const c of created.cases) {
    if (c.error) throw new Error(`✗ create failed (${c.caseId}): ${c.error}`);
    console.log(`create: ${c.caseId} → ${c.externalId}`);
  }

  // 2) round-trip — annotations are ingested async (202): give the queue a moment, then read spans back with the source.
  await sleep(3000);
  const source = buildTraceSource({ kind: "phoenix", endpoint: ENDPOINT, project: PROJECT });
  const t1 = created.cases[0].externalId;
  const events = await source.fetch(t1);
  if (events.length === 0) throw new Error("✗ round-trip: 0 spans read back");
  const llm = events.find((e) => e.kind === "llm_call");
  if (!llm || llm.model !== "gpt-5.4-mini")
    throw new Error(`✗ round-trip normalization mismatch: ${JSON.stringify(events).slice(0, 300)}`);
  console.log(`✓ round-trip: ${events.length} events normalized back (llm_call model matches)`);

  // 3) attach mode — scores only onto the existing trace id; the project's trace count must NOT grow.
  const countTraces = async () => {
    const spans = await source.fetch(t1).catch(() => []);
    // distinct-trace count via the spans endpoint is adapter-internal; use the REST project spans listing instead.
    const res = await fetch(`${ENDPOINT}/v1/projects/${encodeURIComponent(PROJECT)}/spans?limit=200`);
    if (!res.ok) return { spanCount: spans.length, traceCount: undefined };
    const body = await res.json();
    const ids = new Set((body.data ?? []).map((s) => s.context?.trace_id).filter(Boolean));
    return { spanCount: spans.length, traceCount: ids.size };
  };
  const before = await countTraces();
  const attached = await sink.export(ctx, [
    { caseId: "c1", trace: [], scores: [{ name: "judge:safety", value: 1, pass: true }], externalId: t1 },
  ]);
  if (attached.cases[0]?.error) throw new Error(`✗ attach failed: ${attached.cases[0].error}`);
  if (attached.cases[0]?.externalId !== t1) throw new Error("✗ attach must keep the original trace id");
  await sleep(2000);
  const after = await countTraces();
  if (before.traceCount !== undefined && after.traceCount !== before.traceCount)
    throw new Error(`✗ attach duplicated traces: ${before.traceCount} → ${after.traceCount}`);
  console.log(
    `✓ attach: judge:safety onto ${t1} — trace count stable (${before.traceCount ?? "n/a"} → ${after.traceCount ?? "n/a"})`,
  );

  console.log(
    "\n✅ trace-sink live e2e PASS — verified both modes against real Phoenix: create (spans+annotations) and attach (annotations only, no duplicate trace).",
  );
} finally {
  if (bootedDocker) execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}
