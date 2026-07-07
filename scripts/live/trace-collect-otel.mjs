// live e2e: OTel tag correlation (correlate="tag") verified against a *real Jaeger* —
// docs/architecture/streaming-case-pipeline.md D4. Unlike the mlflow/phoenix e2e, this script has no seed:
// **the command (instrumented agent) itself** exports spans under its own minted OTLP trace id, leaving only the
// everdict.run_id=$EVERDICT_RUN_ID resource attribute — everdict never tells anyone the runId in advance (runCase mints it)
// and correlates purely by tag search. I.e. the full round-trip of the "real instrumented agent + injected env" contract.
//   O1 collect="job":           after release, collectTrace(runId) pulls via Jaeger search (service+tags).
//   O2 collect="control-plane": traceRef{correlate:"tag", service} → executeCase does search pull + deferred grading.
// Setup: docker (the script boots/tears down jaegertracing/all-in-one). For an existing server, use JAEGER_QUERY/OTLP_URL.
// Usage: node scripts/live/trace-collect-otel.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { executeCase } from "../../apps/api/dist/execute-case.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { CommandHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";
import { buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-trace-collect-otel";
const SERVICE = "instrumented-cli";
let bootedDocker = false;
let QUERY = process.env.JAEGER_QUERY ?? "";
let OTLP = process.env.OTLP_URL ?? "";

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

if (!QUERY) {
  QUERY = "http://127.0.0.1:16688";
  OTLP = "http://127.0.0.1:14319";
  console.log(`Jaeger boot (docker, all-in-one) → query ${QUERY} / OTLP ${OTLP}`);
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "14319:4318",
    "-p",
    "16688:16686",
    "jaegertracing/all-in-one:1.62.0",
  ]);
  bootedDocker = true;
}
for (let i = 0; i < 60 && !(await up(`${QUERY}/api/services`)); i++) await sleep(1000);
if (!(await up(`${QUERY}/api/services`))) throw new Error(`Jaeger did not come up: ${QUERY}`);
console.log(`Jaeger up: ${QUERY}`);

function assert(cond, label) {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
}

// Script playing the instrumented agent — OTLP export under its own minted trace id, correlation only via resource attributes.
// (Reproduces in shell the same contract a real agent honors via OTEL_RESOURCE_ATTRIBUTES=everdict.run_id=….)
const EMIT_SH = `set -e
TID=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')
SID=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')
SID2=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')
NOW=$(date +%s)000000000
cat > payload.json <<JSON
{"resourceSpans":[{"resource":{"attributes":[
 {"key":"service.name","value":{"stringValue":"${SERVICE}"}},
 {"key":"everdict.run_id","value":{"stringValue":"$EVERDICT_RUN_ID"}}]},
 "scopeSpans":[{"scope":{"name":"e2e"},"spans":[
 {"traceId":"$TID","spanId":"$SID","name":"chat","kind":1,
  "startTimeUnixNano":"$NOW","endTimeUnixNano":"$NOW",
  "attributes":[{"key":"gen_ai.request.model","value":{"stringValue":"gpt-5.4-mini"}},
  {"key":"gen_ai.usage.input_tokens","value":{"intValue":"42"}},
  {"key":"gen_ai.usage.output_tokens","value":{"intValue":"7"}}]},
 {"traceId":"$TID","spanId":"$SID2","name":"bash","kind":1,
  "startTimeUnixNano":"$NOW","endTimeUnixNano":"$NOW",
  "attributes":[{"key":"tool.name","value":{"stringValue":"bash"}},
  {"key":"tool.call_id","value":{"stringValue":"c1"}}]}]}]}]}
JSON
curl -sf -X POST -H 'content-type: application/json' --data @payload.json "$OTLP_BASE/v1/traces" > /dev/null
echo "run_id=$EVERDICT_RUN_ID" > marker.txt
`;

try {
  const specFor = (collect) => ({
    kind: "command",
    id: "instrumented-cli",
    version: "1.0.0",
    setup: [],
    command: "sh emit.sh",
    env: { OTLP_BASE: OTLP }, // the agent's export target (literal env — same channel as the real spec)
    params: {},
    trace: { kind: "otel", endpoint: QUERY, collect, correlate: "tag", service: SERVICE },
  });
  const graderSpecs = [{ id: "tests-pass", config: { cmd: "test -f marker.txt" } }, { id: "steps" }, { id: "cost" }];
  const caseFor = (id) => ({
    id,
    env: { kind: "repo", source: { files: { "emit.sh": EMIT_SH } } },
    task: "export a trace, leave a marker",
    graders: graderSpecs,
    timeoutSec: 120,
    tags: [],
  });
  // Don't pass runCtx.runId — the key runCase mints flows into env, becomes the tag, and we find it by that tag alone.
  const depsFor = (collect) => ({
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness: new CommandHarness(specFor(collect)),
    graders: makeGraders(graderSpecs),
    runCtx: { apiKeyEnv: {}, timeoutSec: 120 },
  });
  const score = (r, id) => r.scores.find((s) => s.graderId === id);

  // 1) O1 — collect="job": after release, Jaeger tag-search pull (retries absorb ingest lag).
  console.log("\n=== O1: collect=job — agent export → tag-search in-job collection ===");
  const r1 = await runCase(caseFor("c-job"), depsFor("job"));
  const llm1 = r1.trace.find((e) => e.kind === "llm_call");
  assert(
    llm1?.model === "gpt-5.4-mini",
    "O1 tag search collects real Jaeger spans (only the agent knows the trace id)",
  );
  assert(score(r1, "tests-pass")?.pass === true, "O1 ground-truth PASS");
  assert((score(r1, "steps")?.value ?? 0) > 0, "O1 steps derived");
  assert(r1.traceRef === undefined, "O1 no traceRef (in-job collection)");

  // 2) O2 — collect="control-plane": traceRef(correlate/service) → executeCase completes via search pull.
  console.log("\n=== O2: collect=control-plane — traceRef(tag/service) → out-of-job collection completes ===");
  const pre = await runCase(caseFor("c-cp"), depsFor("control-plane"));
  assert(
    pre.traceRef?.kind === "otel" && pre.traceRef?.correlate === "tag" && pre.traceRef?.service === SERVICE,
    "O2 traceRef carries kind/correlate/service",
  );
  assert(pre.snapshot.diff.includes(`run_id=${pre.traceRef?.runId}`), "O2 key the agent saw = traceRef.runId");
  const job = { evalCase: caseFor("c-cp"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const done = await executeCase({ dispatcher: { dispatch: async () => pre }, buildTraceSource }, "e2e", job);
  assert(
    done.trace.find((e) => e.kind === "llm_call")?.model === "gpt-5.4-mini",
    "O2 completed via real Jaeger search pull",
  );
  assert((score(done, "steps")?.value ?? 0) > 0, "O2 deferred steps grading");
  assert(score(done, "tests-pass")?.pass === true, "O2 ground-truth preserved");

  console.log(
    "\n✅ trace-collect otel live e2e PASS — full tag-correlation round-trip against real Jaeger (agent-minted trace id; everdict correlates only via the everdict.run_id resource attribute).",
  );
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker teardown done)");
    } catch {}
  }
}
