// 라이브: ServiceTopologyBackend 가 **브라우저 환경 포함** service-topology 를 실 OSS 로 e2e — browser-use-langgraph 그대로.
// 에이전트(aegra browser_agent 그래프)가 per-case Chromium(chromedp CDP)을 조작(navigate+extract)하고, Assay 가
// 같은 브라우저를 스냅샷(URL/DOM)해서 채점한다. 모델은 우리 LiteLLM gpt-5.4-mini.
//   dispatch → ensureTopology(aegra) → provisionBrowserEnv(per-case chromedp CDP) → submit(Agent Protocol +
//   browser_cdp_url 주입) → 에이전트가 브라우저 조작 → traceSource(응답) + browser.snapshot(/json/list) → grade.
//
// 준비: aegra(:2026, browser_agent 그래프 + playwright) + chromedp 컨테이너(assay-cdp, CDP :9222) 가 떠 있어야 함.
//   docker run -d --name assay-cdp -p 9222:9222 chromedp/headless-shell:latest
//   (aegra 셋업은 docs/service-harness.md "browser env" 절 참고)
// 사용: node scripts/live/service-topology-aegra-browser.mjs
import { execSync } from "node:child_process";
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const AEGRA = (process.env.AEGRA_URL ?? "http://localhost:2026").replace(/\/$/, "");
const CDP_HOST = process.env.CDP_HOST ?? "http://localhost:9222"; // 이 스크립트(호스트)의 스냅샷용 뷰
// 에이전트(aegra 컨테이너)가 도달할 chromedp 주소 — 컨테이너 IP 자동 해석(없으면 기본 게이트웨이).
const CDP_AGENT =
  process.env.CDP_AGENT ??
  (() => {
    try {
      const ip = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' assay-cdp")
        .toString()
        .trim();
      return ip ? `http://${ip}:9222` : "http://172.17.0.1:9222";
    } catch {
      return "http://172.17.0.1:9222";
    }
  })();

// browser-use-langgraph 모양의 service 하니스(브라우저 타깃 포함).
const spec = {
  kind: "service",
  id: "browser-use-aegra",
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
  dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["dom", "url"] },
  frontDoor: { service: "agent-server", submit: "POST /threads/{thread_id}/runs/wait" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};

const cdp = async (path, method) => (await fetch(`${CDP_HOST}${path}`, method ? { method } : {})).json();

const runtime = {
  id: "aegra+chromedp",
  async ensureTopology() {
    return { endpoints: { "agent-server": AEGRA } };
  },
  async provisionBrowserEnv() {
    // per-case 리셋: 기존 page 닫고 about:blank 로 시작.
    try {
      for (const t of (await cdp("/json/list")).filter((x) => x.type === "page")) {
        await fetch(`${CDP_HOST}/json/close/${t.id}`);
      }
      await fetch(`${CDP_HOST}/json/new?about:blank`, { method: "PUT" });
    } catch {}
    return {
      cdpUrl: CDP_AGENT, // 에이전트가 조작할 브라우저 주소(backend 가 submit payload 로 전달)
      async snapshot() {
        try {
          const tgs = await cdp("/json/list");
          const pg =
            tgs.find((t) => t.type === "page" && t.url && !t.url.startsWith("about:")) ??
            tgs.find((t) => t.type === "page");
          return { kind: "browser", url: pg?.url ?? "", dom: pg?.title ?? "" };
        } catch {
          return { kind: "browser", url: "", dom: "" };
        }
      },
      async dispose() {},
    };
  },
};

let captured = [];
const ap = async (path, body) => {
  const r = await fetch(`${AEGRA}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
};
const submit = async (_url, payload) => {
  const s = await ap("/assistants/search", { graph_id: "browser_agent" });
  const arr = Array.isArray(s) ? s : (s.assistants ?? []);
  const assistantId = arr[0]?.assistant_id ?? (await ap("/assistants", { graph_id: "browser_agent" })).assistant_id;
  await ap("/threads", { thread_id: payload.thread_id });
  const res = await ap(`/threads/${payload.thread_id}/runs/wait`, {
    assistant_id: assistantId,
    input: { messages: [{ role: "user", content: payload.task }] },
    config: { configurable: { browser_cdp_url: payload.browser_cdp_url } }, // 에이전트가 조작할 브라우저
  });
  captured = res.messages ?? res.values?.messages ?? [];
};

const traceSource = {
  async fetch() {
    return captured.map((m, i) => {
      const role = ["human", "user"].includes(m.type ?? m.role) ? "user" : "assistant";
      const c = Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join(" ") : (m.content ?? "");
      return { t: i, kind: "message", role, text: String(c) };
    });
  },
};

// 브라우저 그레이더: 에이전트가 브라우저를 목표 URL 로 이동시켰나(Assay 가 같은 브라우저를 스냅샷).
const browserGrader = {
  id: "browser-url",
  async grade(ctx) {
    const u = ctx.snapshot?.kind === "browser" ? ctx.snapshot.url : "";
    const pass = /example\.com/.test(u);
    return { graderId: "browser-url", metric: "browser_url", value: pass ? 1 : 0, pass, detail: u };
  },
};
const answerGrader = {
  id: "answer-ok",
  async grade(ctx) {
    const ai = ctx.trace.filter((e) => e.kind === "message" && e.role === "assistant");
    const last = ai.at(-1)?.text ?? "";
    const pass = last.length > 0 && /done/i.test(last);
    return { graderId: "answer-ok", metric: "answer_ok", value: pass ? 1 : 0, pass, detail: last.slice(0, 160) };
  },
};

const backend = new ServiceTopologyBackend({
  runtime,
  traceSource,
  submit,
  specFor: () => spec,
  graders: [browserGrader, answerGrader],
  newRunId: () => `ts${Date.now().toString(36)}`,
});

const job = {
  harness: { id: "browser-use-aegra", version: "1.0.0" },
  tenant: "acme",
  evalCase: {
    id: "browser-case-1",
    env: { kind: "repo", source: { files: {} } },
    task: "Go to https://example.com and report the main heading and what the page is for. End with DONE.",
    graders: [],
    timeoutSec: 120,
    tags: ["live", "service-topology", "browser"],
  },
};

console.log(`ServiceTopologyBackend(${backend.id}) → aegra browser_agent + chromedp(agent=${CDP_AGENT}) …`);
const r = await backend.dispatch(job);
const ans = r.trace.filter((e) => e.kind === "message" && e.role === "assistant").at(-1)?.text ?? "";
console.log("snapshot:", JSON.stringify(r.snapshot));
console.log("agent   :", ans.slice(0, 200));
console.log("scores  :", r.scores.map((s) => `${s.graderId}:${s.value}(${s.pass ? "pass" : "fail"})`).join(", "));
const ok = r.scores.every((s) => s.pass);
console.log(
  ok
    ? "\n✅ 브라우저 환경 포함 service-topology e2e — 에이전트가 per-case Chromium(CDP) 조작 + Assay 가 브라우저 스냅샷(URL/DOM) 채점 + 실 모델"
    : "\n⚠️ 일부 grader fail",
);
process.exit(ok ? 0 : 1);
