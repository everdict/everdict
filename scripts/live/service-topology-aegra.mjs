// 라이브: 우리 **ServiceTopologyBackend** 가 실제 OSS LangGraph 하니스(aegra)를 service-topology 모양으로 구동하고
// 채점한다. 토폴로지 백엔드의 주입점(runtime/submit/traceSource/graders)만 써서 패키지 변경 없이 e2e:
//   dispatch → ensureTopology(외부 aegra 엔드포인트) → provisionBrowserEnv(no-op) → submit(Agent Protocol frontDoor,
//   per-run thread_id 격리) → traceSource(run/wait 응답 메시지 → TraceEvent[]) → grade.
// per-run thread_id(=run-<runId>)가 aegra 의 Postgres 체크포인트 격리 키 — 플랜의 isolateBy:thread_id 그대로.
//
// 준비: aegra 가 :2026 에 떠 있어야 함(docs/service-harness.md "Real OSS harness e2e — aegra" 레시피).
// 사용: [AEGRA_URL=http://localhost:2026] node scripts/live/service-topology-aegra.mjs
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const AEGRA = (process.env.AEGRA_URL ?? "http://localhost:2026").replace(/\/$/, "");

// aegra = browser-use-langgraph 에서 브라우저 뺀 service 하니스 스펙.
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
  traceSource: { kind: "otel", endpoint: "http://unused" }, // 아래 opts.traceSource 가 실제 소스(응답 메시지)
};

// 이미 떠 있는 aegra 를 가리키는 런타임(배포 안 함). 브라우저 타깃 없음 → no-op 핸들.
const runtime = {
  id: "aegra-external",
  async ensureTopology() {
    return { endpoints: { "agent-server": AEGRA } };
  },
  async provisionBrowserEnv() {
    return {
      cdpUrl: "",
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

// frontDoor 구동 = Agent Protocol(assistant→thread[thread_id]→run/wait). 응답 메시지를 캡처.
let captured = [];
const submit = async (_url, payload) => {
  const s = await ap("/assistants/search", { graph_id: "agent" });
  const arr = Array.isArray(s) ? s : (s.assistants ?? []);
  const assistantId = arr[0]?.assistant_id ?? (await ap("/assistants", { graph_id: "agent" })).assistant_id;
  await ap("/threads", { thread_id: payload.thread_id }); // per-run thread_id = checkpoint 격리
  const res = await ap(`/threads/${payload.thread_id}/runs/wait`, {
    assistant_id: assistantId,
    input: { messages: [{ role: "user", content: payload.task }] },
  });
  captured = res.messages ?? res.values?.messages ?? [];
};

// 하니스의 실제 run/wait 응답 → TraceEvent[](OTel 끄여 있어 응답을 트레이스로 사용).
const traceSource = {
  async fetch() {
    return captured.map((m, i) => {
      const role = ["human", "user"].includes(m.type ?? m.role) ? "user" : "assistant";
      const c = Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join(" ") : (m.content ?? "");
      return { t: i, kind: "message", role, text: String(c) };
    });
  },
};

// 에이전트 최종 답이 비어있지 않고 지시(DONE) 준수?
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
    ? "\n✅ ServiceTopologyBackend 가 실 OSS LangGraph 하니스(aegra)를 토폴로지로 구동+채점 — per-run thread_id 격리 + Agent Protocol frontDoor + 실 모델(gpt-5.4-mini)"
    : "\n❌ fail",
);
process.exit(ok ? 0 : 1);
