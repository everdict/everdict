// Live: our **ServiceTopologyBackend** drives a real OSS LangGraph harness (aegra) in a service-topology shape and
// grades it. Uses only the topology backend's injection points (runtime/submit/traceSource/graders) for an e2e with no package changes:
//   dispatch → ensureTopology(external aegra endpoint) → provisionBrowserEnv(no-op) → submit(Agent Protocol frontDoor,
//   per-run thread_id isolation) → traceSource(run/wait response messages → TraceEvent[]) → grade.
// The per-run thread_id (=run-<runId>) is aegra's Postgres checkpoint isolation key — the plan's isolateBy:thread_id as-is.
//
// Prereqs: aegra must be up on :2026 (docs/service-harness.md "Real OSS harness e2e — aegra" recipe).
// Usage: [AEGRA_URL=http://localhost:2026] node scripts/live/service-topology-aegra.mjs
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const AEGRA = (process.env.AEGRA_URL ?? "http://localhost:2026").replace(/\/$/, "");

// aegra = the browser-use-langgraph service harness spec with the browser removed.
const spec = {
  kind: "service",
  id: "langgraph-aegra",
  version: "1.0.0",
  services: [
    {
      name: "agent-server",
      image: "aegra:local",
      port: 2026,
      needs: ["postgres", "redis"],
      perRun: ["thread_id"],
      replicas: 1,
    },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", isolateBy: "thread_id" },
    { store: "redis", role: "broker", isolateBy: "key-prefix" },
  ],
  frontDoor: { service: "agent-server", submit: "POST /threads/{thread_id}/runs/wait" },
  traceSource: { kind: "otel", endpoint: "http://unused" }, // opts.traceSource below is the actual source (response messages)
};

// A runtime pointing at an already-running aegra (no deploy). No browser target → no-op handle.
const runtime = {
  id: "aegra-external",
  async ensureTopology() {
    return { endpoints: { "agent-server": AEGRA } };
  },
  async provisionBrowserEnv() {
    return {
      wiring: { target_cdp_url: "" },
      async snapshot() {
        return { kind: "browser", url: "", dom: "" };
      },
      async dispose() {},
    };
  },
};

const ap = async (path, body) => {
  const r = await fetch(`${AEGRA}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// Driving frontDoor = Agent Protocol (assistant→thread[thread_id]→run/wait). Capture the response messages.
let captured = [];
const submit = async (_url, payload) => {
  const s = await ap("/assistants/search", { graph_id: "agent" });
  const arr = Array.isArray(s) ? s : (s.assistants ?? []);
  const assistantId = arr[0]?.assistant_id ?? (await ap("/assistants", { graph_id: "agent" })).assistant_id;
  await ap("/threads", { thread_id: payload.thread_id }); // per-run thread_id = checkpoint isolation
  const res = await ap(`/threads/${payload.thread_id}/runs/wait`, {
    assistant_id: assistantId,
    input: { messages: [{ role: "user", content: payload.task }] },
  });
  captured = res.messages ?? res.values?.messages ?? [];
};

// The harness's actual run/wait response → TraceEvent[] (OTel is off, so use the response as the trace).
const traceSource = {
  async fetch() {
    return captured.map((m, i) => {
      const role = ["human", "user"].includes(m.type ?? m.role) ? "user" : "assistant";
      const c = Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join(" ") : (m.content ?? "");
      return { t: i, kind: "message", role, text: String(c) };
    });
  },
};

// Is the agent's final answer non-empty and does it follow the instruction (DONE)?
const grader = {
  id: "answer-ok",
  async grade(ctx) {
    const ai = ctx.trace.filter((e) => e.kind === "message" && e.role === "assistant");
    const last = ai.at(-1)?.text ?? "";
    const pass = last.length > 0 && /done/i.test(last);
    return { graderId: "answer-ok", metric: "answer_ok", value: pass ? 1 : 0, pass, detail: last.slice(0, 200) };
  },
};

const backend = new ServiceTopologyBackend({
  runtime,
  traceSource,
  submit,
  specFor: () => spec,
  graders: [grader],
  newRunId: () => `ts${Date.now().toString(36)}`,
});

const job = {
  harness: { id: "langgraph-aegra", version: "1.0.0" },
  tenant: "acme",
  evalCase: {
    id: "aegra-case-1",
    env: { kind: "repo", source: { files: {} } },
    task: "In one sentence, what is an evaluation harness for AI agents? End with the word DONE.",
    graders: [],
    timeoutSec: 120,
    tags: ["live", "service-topology", "aegra"],
  },
};

console.log(`ServiceTopologyBackend(${backend.id}) → aegra(${AEGRA}) via Agent Protocol frontDoor …`);
const r = await backend.dispatch(job);
const answer = r.trace.filter((e) => e.kind === "message" && e.role === "assistant").at(-1)?.text ?? "";
console.log("harness :", r.harness);
console.log("trace   :", `${r.trace.length} events`);
console.log("agent   :", answer.slice(0, 240));
console.log("scores  :", r.scores.map((s) => `${s.graderId}:${s.value}(${s.pass ? "pass" : "fail"})`).join(", "));
const ok = r.scores.some((s) => s.graderId === "answer-ok" && s.pass);
console.log(
  ok
    ? "\n✅ ServiceTopologyBackend drives + grades a real OSS LangGraph harness (aegra) as a topology — per-run thread_id isolation + Agent Protocol frontDoor + real model (gpt-5.4-mini)"
    : "\n❌ fail",
);
process.exit(ok ? 0 : 1);
