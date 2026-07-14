// Live: the REAL LLM-driven browser agent, run THROUGH the everdict engine (not raw curl + raw judge), exercising the
// four gap fixes end to end:
//   G2 inline trace  — agent-real returns { output, events: TraceEvent[] } inline; the spec's frontDoor.traceInline
//                       makes ServiceTopologyBackend extract those steps into CaseResult.trace (no OTel/MLflow platform).
//   judge (engine)   — a real JudgeGrader (modelJudge → LiteLLM) scores the answer AND sees the agent's action steps.
//   steps grader     — stepsGrader counts tool_call events; > 0 proves the inline trace's steps reached the grading layer.
//   G3 reachability   — the agent container calls host LiteLLM via host.docker.internal (docker0 gw is ufw-blocked here).
// The engine provisions the per-case extension browser (custom DockerTopologyRuntime), front-doors the task with the
// injected browser_cdp_url, and the agent drives that browser to read the extractor-extension-unmasked access code.
//
// Prereqs: LiteLLM(:4000). Images (built by this script if missing):
//   everdict-bxa-agent-real:1  everdict-extractor-ext:1  everdict-bxa-tasksite:1
// Run:  node scripts/live/browser-ext-agent-engine.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { JudgeGrader, modelJudge, openaiComplete, stepsGrader } from "../../packages/graders/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const MODEL = process.env.LG_MODEL ?? "gpt-5.4-mini";
const EXPECTED = "EVDX-4242";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (a) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const dtry = (a) => {
  try {
    return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
};
const ip = (name) => docker(["inspect", name, "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
const haveImage = (t) => dtry(["image", "inspect", t]) !== "";
const buildIfMissing = (tag, ctx) => {
  if (!haveImage(tag)) {
    console.log(`  building ${tag} …`);
    docker(["build", "-q", "-t", tag, ctx]);
  }
};

function llmKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    return (readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8").match(
      /^LITELLM_MASTER_KEY=(.+)$/m,
    ) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = llmKey();
if (!KEY) {
  console.error("no LLM key (set OPENAI_API_KEY or infra/litellm/.env)");
  process.exit(2);
}

async function cdpReady(cdpUrl) {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${cdpUrl}/json/version`)).ok) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

async function main() {
  console.log("\n\x1b[1mReal browser agent THROUGH the everdict engine — inline trace (G2) + engine judge\x1b[0m");
  buildIfMissing("everdict-bxa-agent-real:1", "examples/bundles/browser-ext-agent/agent-real");
  buildIfMissing("everdict-extractor-ext:1", "examples/browser-extensions/extractor-ext");
  buildIfMissing("everdict-bxa-tasksite:1", "examples/bundles/browser-ext-agent/tasksite");

  const browsers = [];
  dtry(["rm", "-f", "bxe-site", "bxe-agent"]);
  // The task site (search form → masked results) and the agent (reaches host LiteLLM via host.docker.internal — G3).
  docker(["run", "-d", "--name", "bxe-site", "everdict-bxa-tasksite:1"]);
  docker([
    "run",
    "-d",
    "--name",
    "bxe-agent",
    "--add-host=host.docker.internal:host-gateway",
    "-e",
    `OPENAI_API_KEY=${KEY}`,
    "-e",
    "OPENAI_BASE_URL=http://host.docker.internal:4000/v1",
    "-e",
    `MODEL=${MODEL}`,
    "-e",
    "MAX_STEPS=10",
    "everdict-bxa-agent-real:1",
  ]);
  const siteUrl = `http://${ip("bxe-site")}:8080`;
  const agentUrl = `http://${ip("bxe-agent")}:8000`;
  console.log(`site=${siteUrl} agent=${agentUrl} ; warming up…`);
  await sleep(8000);

  // The service-topology harness: one agent service + a per-case browser target with the extractor extension. The
  // frontDoor injects {{target_cdp_url}} into the request body, and traceInline extracts the agent's steps (path "events").
  const spec = {
    kind: "service",
    id: "browser-ext-agent-real",
    version: "1.0.0",
    services: [
      { name: "agent", image: "everdict-bxa-agent-real:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
    ],
    dependencies: [],
    target: {
      kind: "browser",
      engine: "chromium",
      extension: { ref: "everdict-extractor-ext:1" },
      lifecycle: "per-case-instance",
      observe: ["dom", "url"],
    },
    frontDoor: {
      service: "agent",
      submit: "POST /runs",
      request: { bodyTemplate: { task: "{{task}}", browser_cdp_url: "{{target_cdp_url}}" } },
      traceInline: { path: "events" },
    },
    traceSource: { kind: "otel", endpoint: "http://unused" }, // superseded by traceInline
  };

  // Custom DockerTopologyRuntime: the agent is warm; each case gets a fresh extractor-extension browser container.
  const runtime = {
    id: "docker-local",
    async ensureTopology() {
      return { endpoints: { agent: agentUrl } };
    },
    async provisionBrowserEnv() {
      const name = `bxe-br-${Math.random().toString(36).slice(2, 8)}`;
      browsers.push(name);
      docker(["run", "-d", "--name", name, "everdict-extractor-ext:1"]);
      const brIp = ip(name);
      const hostCdp = `http://${brIp}:9222`;
      await cdpReady(hostCdp);
      return {
        wiring: { target_cdp_url: hostCdp }, // the agent reaches the browser by its bridge IP:9222
        async snapshot() {
          try {
            const tgs = await (await fetch(`${hostCdp}/json/list`)).json();
            const pg =
              tgs.find((t) => t.type === "page" && t.url && !t.url.startsWith("about:")) ??
              tgs.find((t) => t.type === "page");
            return { kind: "browser", url: pg?.url ?? "", dom: pg?.title ?? "" };
          } catch {
            return { kind: "browser", url: "", dom: "" };
          }
        },
        async dispose() {
          dtry(["rm", "-f", name]);
        },
      };
    },
  };

  // Front-door submit — POST the task to agent-real and return its JSON body (becomes DriveOutcome.response, from which
  // traceInline extracts .events). Long timeout: the ReAct loop makes several sequential LLM calls.
  const submit = async (url, payload) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(280000),
    });
    if (!r.ok) throw new Error(`submit ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.json();
  };

  // The engine judge: a real model judge (LiteLLM) that scores the answer and SEES the agent's action steps (ctx.trace).
  const judge = new JudgeGrader(
    modelJudge(openaiComplete({ apiKey: KEY, model: MODEL, baseUrl: "http://127.0.0.1:4000/v1" })),
    {
      id: "judge",
      rubric: `The agent must report the exact access code ${EXPECTED} read from the results page. Pass ONLY if the final answer contains ${EXPECTED}.`,
    },
  );

  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource: {
      async fetch() {
        return [];
      },
    }, // unused: traceInline supersedes it
    submit,
    specFor: () => spec,
    graders: [stepsGrader, judge],
    newRunId: () => `bxe${Math.random().toString(36).slice(2, 9)}`,
  });

  const job = {
    harness: { id: "browser-ext-agent-real", version: "1.0.0" },
    tenant: "acme",
    evalCase: {
      id: "ext-code-case",
      env: { kind: "repo", source: { files: {} } }, // cosmetic in a service topology (the browser target is the env)
      task: `Go to ${siteUrl} , search for 'everdict', then tell me the access code shown on the results page.`,
      expected: EXPECTED,
      graders: [],
      timeoutSec: 280,
      tags: ["live", "service-topology", "browser", "inline-trace"],
    },
  };

  console.log(`\nServiceTopologyBackend(${backend.id}) → agent drives per-case extractor-ext browser …`);
  let result;
  try {
    result = await backend.dispatch(job);
  } finally {
    for (const b of browsers) dtry(["rm", "-f", b]);
    dtry(["rm", "-f", "bxe-site", "bxe-agent"]);
  }

  // Evidence the inline trace (G2) reached the engine: the extracted CaseResult.trace carries the agent's action steps.
  const kinds = result.trace.map((e) => e.kind);
  const toolCalls = result.trace.filter((e) => e.kind === "tool_call");
  const answer = result.trace.filter((e) => e.kind === "message" && e.role === "assistant").at(-1)?.text ?? "";
  const score = (id) => result.scores.find((s) => s.graderId === id);

  console.log("\n\x1b[1m=== engine CaseResult ===\x1b[0m");
  console.log(`  inline trace extracted: ${result.trace.length} events — kinds: ${[...new Set(kinds)].join(", ")}`);
  console.log(`  agent action steps (tool_call): ${toolCalls.map((t) => t.name).join(" → ") || "(none)"}`);
  console.log(`  agent final answer: "${String(answer).slice(0, 80).replace(/\n/g, " ")}"`);
  console.log(`  snapshot: ${JSON.stringify(result.snapshot).slice(0, 120)}`);
  console.log(
    `  scores: ${result.scores.map((s) => `${s.graderId}=${s.value}(${s.pass ? "pass" : "fail"})`).join(", ")}`,
  );

  const stepsScore = score("steps");
  const judgeScore = score("judge");
  const inlineOk = toolCalls.length > 0; // proves traceInline extracted the agent's steps (empty without G2)
  const stepsOk = (stepsScore?.value ?? 0) > 0;
  const judgeOk = judgeScore?.pass === true;
  const proven = inlineOk && stepsOk && judgeOk;

  console.log("\n\x1b[1m=== RESULT ===\x1b[0m");
  console.log(`  G2 inline trace → engine saw the action steps (tool_call > 0): ${inlineOk ? "✓" : "✗"}`);
  console.log(`  steps grader scored the inline trace (value > 0):             ${stepsOk ? "✓" : "✗"}`);
  console.log(`  engine JudgeGrader (LiteLLM) scored the answer PASS:          ${judgeOk ? "✓" : "✗"}`);
  console.log(
    proven
      ? "\n\x1b[32m✅ The real agent ran THROUGH the everdict engine: provisioned extension browser → agent drove it → inline trace extracted → judged. eval-through-everdict, not scripts.\x1b[0m"
      : `\n\x1b[31m⚠️ inconclusive (inline=${inlineOk}, steps=${stepsOk}, judge=${judgeOk})\x1b[0m`,
  );
  process.exit(proven ? 0 : 1);
}
main().catch((e) => {
  dtry(["rm", "-f", "bxe-site", "bxe-agent"]);
  console.error(e);
  process.exit(1);
});
