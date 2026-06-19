// 라이브(service-topology, 실제 OSS 하니스): aegra(오픈소스 self-hosted LangGraph 서버, Agent Protocol)에 떠 있는
// ReAct 에이전트를 우리 모델(workclaw LiteLLM gpt-5.4-mini)로 구동하고 응답을 채점한다. browser-use-langgraph 와 같은
// service-topology 모양(agent-server + Postgres checkpoints[thread_id] + Redis + HTTP frontDoor)을 실제 OSS 로 e2e.
//
// 준비(요지 — docs/service-harness.md 의 "Real OSS harness e2e: aegra" 참고):
//   git clone https://github.com/aegra/aegra && cd aegra
//   .env: OPENAI_API_KEY=<litellm key>, OPENAI_BASE_URL=http://172.17.0.1:4000, MODEL=openai/gpt-5.4-mini
//   docker compose up -d --build && docker network connect bridge aegra-aegra-1   # 호스트 LiteLLM 도달용
// 사용: [AEGRA_URL=http://localhost:2026] node scripts/live/aegra-langgraph.mjs
import process from "node:process";

const B = (process.env.AEGRA_URL ?? "http://localhost:2026").replace(/\/$/, "");
const TASK =
  process.env.TASK ?? "In one sentence, what is an evaluation harness for AI agents? End with the word DONE.";

const j = async (path, body) => {
  const r = await fetch(`${B}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// Agent Protocol: assistant(graph "agent") → thread → run/wait. (frontDoor 구동 = ServiceHarness.drive 의 OSS 버전)
const search = await j("/assistants/search", { graph_id: "agent" });
const assistants = Array.isArray(search) ? search : (search.assistants ?? []);
const assistantId = assistants[0]?.assistant_id ?? (await j("/assistants", { graph_id: "agent" })).assistant_id;
const threadId = (await j("/threads", {})).thread_id;
console.log(`aegra ${B} | assistant=${assistantId?.slice(0, 8)} thread=${threadId?.slice(0, 8)}`);
console.log(`task: ${TASK}`);

const t0 = Date.now();
const result = await j(`/threads/${threadId}/runs/wait`, {
  assistant_id: assistantId,
  input: { messages: [{ role: "user", content: TASK }] },
});
const msgs = result.messages ?? result.values?.messages ?? [];
const ai = msgs.filter((m) => (m.type ?? m.role) === "ai" || (m.type ?? m.role) === "assistant");
const last = ai.at(-1)?.content;
const answer = (Array.isArray(last) ? last.map((x) => x.text ?? "").join(" ") : (last ?? "")).trim();
console.log(`\nagent (${((Date.now() - t0) / 1000).toFixed(0)}s, via gpt-5.4-mini): ${answer.slice(0, 280)}`);

const ok = answer.length > 0 && /done/i.test(answer); // 비어있지 않고 지시(DONE)를 따랐는가
console.log(
  ok
    ? "\n✅ OSS LangGraph 하니스(aegra) e2e OK — 실 에이전트가 우리 모델로 과업 수행(service-topology 모양: agent-server+PG[thread_id]+frontDoor)"
    : "\n❌ 응답이 비었거나 지시 미준수",
);
process.exit(ok ? 0 : 1);
