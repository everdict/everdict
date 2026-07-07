// Live: ServiceTopologyBackend runs a **browser-environment** service-topology e2e against real OSS — browser-use-langgraph as-is.
// The agent (aegra browser_agent graph) drives a per-case Chromium (chromedp CDP) (navigate+extract), and Everdict
// snapshots the same browser (URL/DOM) to grade. The model is our LiteLLM gpt-5.4-mini.
//   dispatch → ensureTopology(aegra) → provisionBrowserEnv(per-case chromedp CDP) → submit(Agent Protocol +
//   inject browser_cdp_url) → agent drives the browser → traceSource(response) + browser.snapshot(/json/list) → grade.
//
// Prereqs: aegra (:2026, browser_agent graph + playwright) + chromedp container (everdict-cdp, CDP :9222) must be up.
//   docker run -d --name everdict-cdp -p 9222:9222 chromedp/headless-shell:latest
//   (for aegra setup, see the "browser env" section of docs/service-harness.md)
// Usage: node scripts/live/service-topology-aegra-browser.mjs
import { execSync } from "node:child_process";
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const AEGRA = (process.env.AEGRA_URL ?? "http://localhost:2026").replace(/\/$/, "");
const CDP_HOST = process.env.CDP_HOST ?? "http://localhost:9222"; // this script's (host) view for snapshots
// The chromedp address the agent (aegra container) reaches — auto-resolve the container IP (fall back to the default gateway).
const CDP_AGENT =
  process.env.CDP_AGENT ??
  (() => {
    try {
      const ip = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' everdict-cdp")
        .toString()
        .trim();
      return ip ? `http://${ip}:9222` : "http://172.17.0.1:9222";
    } catch {
      return "http://172.17.0.1:9222";
    }
  })();

// A browser-use-langgraph-shaped service harness (with a browser target).
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
    // per-case reset: close existing pages and start at about:blank.
    try {
      for (const t of (await cdp("/json/list")).filter((x) => x.type === "page")) {
        await fetch(`${CDP_HOST}/json/close/${t.id}`);
      }
      await fetch(`${CDP_HOST}/json/new?about:blank`, { method: "PUT" });
    } catch {}
    return {
      wiring: { target_cdp_url: CDP_AGENT }, // the browser address the agent will drive (backend passes it in the submit payload)
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
    config: { configurable: { browser_cdp_url: payload.browser_cdp_url } }, // the browser the agent will drive
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

// Browser grader: did the agent navigate the browser to the target URL (Everdict snapshots the same browser).
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
    ? "\n✅ browser-environment service-topology e2e — agent drives a per-case Chromium (CDP) + Everdict grades a browser snapshot (URL/DOM) + real model"
    : "\n⚠️ some graders failed",
);
process.exit(ok ? 0 : 1);
