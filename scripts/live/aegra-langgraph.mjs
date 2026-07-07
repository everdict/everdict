// Live (service-topology, real OSS harness): drive a ReAct agent running on aegra (an open-source self-hosted
// LangGraph server, Agent Protocol) with our model (workclaw LiteLLM gpt-5.4-mini) and grade the response. An e2e
// on real OSS of the same service-topology shape as browser-use-langgraph (agent-server + Postgres checkpoints[thread_id] + Redis + HTTP frontDoor).
//
// Setup (gist — see "Real OSS harness e2e: aegra" in docs/service-harness.md):
//   git clone https://github.com/aegra/aegra && cd aegra
//   .env: OPENAI_API_KEY=<litellm key>, OPENAI_BASE_URL=http://172.17.0.1:4000, MODEL=openai/gpt-5.4-mini
//   docker compose up -d --build && docker network connect bridge aegra-aegra-1   # to reach the host LiteLLM
// Usage: [AEGRA_URL=http://localhost:2026] node scripts/live/aegra-langgraph.mjs
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

// Agent Protocol: assistant(graph "agent") → thread → run/wait. (driving the frontDoor = the OSS version of ServiceHarness.drive)
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

const ok = answer.length > 0 && /done/i.test(answer); // non-empty and followed the instruction (DONE)?
console.log(
  ok
    ? "\n✅ OSS LangGraph harness (aegra) e2e OK — a real agent performed the task with our model (service-topology shape: agent-server+PG[thread_id]+frontDoor)"
    : "\n❌ empty response or instruction not followed",
);
process.exit(ok ? 0 : 1);
