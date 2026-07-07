// live e2e: command trace kind extension (phoenix) verified against a *real Arize Phoenix* —
// docs/architecture/streaming-case-pipeline.md D4. Same pattern as the mlflow e2e (trace-collect-mlflow.mjs):
//   P1 collect="job":           after runCase releases compute, collectTrace(runId) pulls from real Phoenix
//                               (via the buildTraceSource factory — verifies the kind extension's real wiring).
//   P2 collect="control-plane": the job returns only traceRef{kind:"phoenix", project} → executeCase does the real pull + deferred grading.
//
// Correlation: Phoenix trace ids are client-minted (OTLP hex) — the trace id created by the seed (PhoenixTraceSink) is
// injected as the runId (pull-ingest convention). The seed plays "a trace ingested by an instrumented agent" (the sink path is already verified).
// Setup: docker (the script boots/tears down arizephoenix/phoenix:latest). For an existing server, use PHOENIX_ENDPOINT.
// Usage: node scripts/live/trace-collect-phoenix.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { executeCase } from "../../apps/api/dist/execute-case.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { CommandHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";
import { buildTraceSink, buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-trace-collect-phoenix";
const PROJECT = "everdict-collect-e2e";
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
  ENDPOINT = "http://127.0.0.1:6116";
  console.log(`Phoenix boot (docker, arizephoenix/phoenix:latest) → ${ENDPOINT}`);
  execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", "6116:6006", "arizephoenix/phoenix:latest"]);
  bootedDocker = true;
}
for (let i = 0; i < 90 && !(await up(ENDPOINT)); i++) await sleep(1000);
if (!(await up(ENDPOINT))) throw new Error(`Phoenix did not come up: ${ENDPOINT}`);
console.log(`Phoenix up: ${ENDPOINT}`);

function assert(cond, label) {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
}

try {
  // 1) Seed — ingest spans via the sink (create) → two client-minted trace ids (for P1/P2).
  const sink = buildTraceSink({ kind: "phoenix", endpoint: ENDPOINT, project: PROJECT });
  const seedTrace = [
    { t: 0, kind: "message", role: "user", text: "task instruction" },
    {
      t: 10,
      kind: "llm_call",
      model: "gpt-5.4-mini",
      cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
      latencyMs: 5,
    },
    { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
  ];
  const seeded = await sink.export({ scorecardId: "sc-e2e", dataset: "d@1", harness: "h@1" }, [
    { caseId: "seed-job", trace: seedTrace, scores: [] },
    { caseId: "seed-cp", trace: seedTrace, scores: [] },
  ]);
  for (const c of seeded.cases) if (c.error) throw new Error(`seed failed (${c.caseId}): ${c.error}`);
  const [tidJob, tidCp] = seeded.cases.map((c) => c.externalId);
  console.log(`seeded traces: job=${tidJob} cp=${tidCp}`);
  const source = buildTraceSource({ kind: "phoenix", endpoint: ENDPOINT, project: PROJECT });
  let seedEvents = [];
  for (let i = 0; i < 20 && seedEvents.length === 0; i++) {
    await sleep(1000);
    seedEvents = await source.fetch(tidJob).catch(() => []);
  }
  assert(
    seedEvents.some((e) => e.kind === "llm_call"),
    `seed spans round-trip ready (${seedEvents.length} events)`,
  );

  const specFor = (collect) => ({
    kind: "command",
    id: "instrumented-cli",
    version: "1.0.0",
    setup: [],
    command: "sh -c 'echo \"run_id=$EVERDICT_RUN_ID\" > marker.txt'",
    env: {},
    params: {},
    trace: { kind: "phoenix", endpoint: ENDPOINT, project: PROJECT, collect },
  });
  const graderSpecs = [{ id: "tests-pass", config: { cmd: "test -f marker.txt" } }, { id: "steps" }, { id: "cost" }];
  const caseFor = (id) => ({
    id,
    env: { kind: "repo", source: { files: { "README.md": "seed\n" } } },
    task: "leave a marker",
    graders: graderSpecs,
    timeoutSec: 120,
    tags: [],
  });
  const depsFor = (collect, runId) => ({
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness: new CommandHarness(specFor(collect)),
    graders: makeGraders(graderSpecs),
    runCtx: { apiKeyEnv: {}, timeoutSec: 120, runId },
  });
  const score = (r, id) => r.scores.find((s) => s.graderId === id);

  // 2) P1 — collect="job": after release, in-job pull round-trip via buildTraceSource(phoenix).
  console.log("\n=== P1: collect=job — in-job pull after release (factory wiring for all 5 kinds) ===");
  const r1 = await runCase(caseFor("c-job"), depsFor("job", tidJob));
  assert(r1.snapshot.diff.includes(`run_id=${tidJob}`), "P1 correlation key round-trip (EVERDICT_RUN_ID)");
  const llm1 = r1.trace.find((e) => e.kind === "llm_call");
  assert(llm1?.model === "gpt-5.4-mini", "P1 real Phoenix spans collected into the trace");
  assert((score(r1, "steps")?.value ?? 0) > 0, "P1 steps derived");
  assert(r1.traceRef === undefined, "P1 no traceRef (in-job collection)");

  // 3) P2 — collect="control-plane": traceRef carries project → executeCase completes.
  console.log("\n=== P2: collect=control-plane — traceRef(project) → out-of-job collection completes ===");
  const pre = await runCase(caseFor("c-cp"), depsFor("control-plane", tidCp));
  assert(
    pre.traceRef?.kind === "phoenix" && pre.traceRef?.project === PROJECT && pre.traceRef?.runId === tidCp,
    "P2 traceRef carries kind/project/runId",
  );
  assert(pre.scores.map((s) => s.graderId).join(",") === "tests-pass", "P2 the job grades ground-truth only");
  const job = { evalCase: caseFor("c-cp"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const done = await executeCase({ dispatcher: { dispatch: async () => pre }, buildTraceSource }, "e2e", job);
  assert(
    done.trace.find((e) => e.kind === "llm_call")?.model === "gpt-5.4-mini",
    "P2 trace completed via real Phoenix pull",
  );
  assert((score(done, "steps")?.value ?? 0) > 0, "P2 deferred steps grading");
  assert(score(done, "tests-pass")?.pass === true, "P2 ground-truth preserved (no double grading)");

  console.log(
    "\n✅ trace-collect phoenix live e2e PASS — the command trace kind extension works against real Phoenix in both D4 modes.",
  );
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker teardown done)");
    } catch {}
  }
}
