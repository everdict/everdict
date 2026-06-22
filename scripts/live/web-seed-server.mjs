// 라이브 (웹 풀스택 시각 검증): 실 컨트롤플레인 HTTP 표면(buildServer)에 *대표 browser-use run/scorecard 레코드*를
// 시드하고 :8787 로 서빙 → 웹 대시보드(next, CONTROL_PLANE_URL 기본 127.0.0.1:8787, KEYCLOAK 미설정=dev tenant)가
// browser 스냅샷(최종 URL+DOM)+스코어(steps/cost)+trace 를 실제로 렌더하는지 확인하기 위한 시드 서버.
// 레코드 값은 이 세션의 실제 browser-use 런(Wikipedia 'Web scraping', tokens 35872/1074, usd 0.006025, navigate→
// input→click→done)에서 가져온 대표값 — POST 디스패치 대신 store 에 직접 시드(요청 취지: run 레코드 시드).
import process from "node:process";
import { RunService } from "../../apps/api/dist/run-service.js";
import { ScorecardService } from "../../apps/api/dist/scorecard-service.js";
import { buildServer } from "../../apps/api/dist/server.js";
import { InMemoryRunStore, InMemoryScorecardStore } from "../../packages/db/dist/index.js";

const now = new Date().toISOString();
const dummyDispatcher = { submit: async () => ({}), capacity: async () => ({ total: 0, used: 0 }) };

const browserTrace = [
  {
    t: 0,
    kind: "llm_call",
    model: "chatgpt/gpt-5.4",
    cost: { inputTokens: 35872, outputTokens: 1074, usd: 0.006025 },
    latencyMs: 1500,
  },
  { t: 1, kind: "tool_call", id: "a0", name: "navigate", args: { url: "https://en.wikipedia.org" } },
  { t: 1, kind: "tool_result", id: "a0", ok: true, output: "" },
  { t: 2, kind: "tool_call", id: "a1", name: "input", args: { text: "Web scraping" } },
  { t: 2, kind: "tool_result", id: "a1", ok: true, output: "" },
  { t: 3, kind: "tool_call", id: "a2", name: "click", args: { target: "search result" } },
  { t: 3, kind: "tool_result", id: "a2", ok: true, output: "" },
  { t: 4, kind: "tool_call", id: "a3", name: "done", args: {} },
  { t: 4, kind: "tool_result", id: "a3", ok: true, output: "" },
  { t: 5, kind: "message", role: "assistant", text: "The exact article title is: Web scraping" },
];
const browserSnapshot = {
  kind: "browser",
  url: "https://en.wikipedia.org/wiki/Web_scraping",
  dom: "🔗 Navigated to https://en.wikipedia.org\nTyped 'Web scraping' into the search box\nClicked the search result\nWeb scraping, web harvesting, or web data extraction is data scraping used for extracting data from websites.",
  console: [],
};
const browserScores = [
  {
    graderId: "answer-match",
    metric: "answer_match",
    value: 1,
    pass: true,
    detail: "The exact article title is: Web scraping",
  },
  { graderId: "steps", metric: "tool_calls", value: 4 },
  { graderId: "cost", metric: "usd", value: 0.006025 },
];

const runStore = new InMemoryRunStore();
await runStore.create({
  id: "bu-demo",
  tenant: "default",
  harness: { id: "browseruse", version: "gpt5.4" },
  caseId: "wiki--0",
  status: "succeeded",
  result: {
    caseId: "wiki--0",
    harness: "browseruse@gpt5.4",
    trace: browserTrace,
    snapshot: browserSnapshot,
    scores: browserScores,
  },
  createdAt: now,
  updatedAt: now,
});

const scorecardStore = new InMemoryScorecardStore();
await scorecardStore.create({
  id: "bu-sc-demo",
  tenant: "default",
  dataset: { id: "webvoyager-sample", version: "v1" },
  harness: { id: "browseruse", version: "gpt5.4" },
  status: "succeeded",
  summary: [
    { metric: "answer_match", count: 3, mean: 1, passRate: 1 },
    { metric: "tool_calls", count: 3, mean: 4 },
    { metric: "usd", count: 3, mean: 0.006611 },
  ],
  scorecard: {
    suiteId: "webvoyager-sample",
    harness: "browseruse@gpt5.4",
    results: [
      {
        caseId: "wiki--0",
        harness: "browseruse@gpt5.4",
        trace: browserTrace,
        snapshot: browserSnapshot,
        scores: browserScores,
      },
      {
        caseId: "example--0",
        harness: "browseruse@gpt5.4",
        trace: [],
        snapshot: { kind: "browser", url: "https://example.com/", dom: "Example Domain", console: [] },
        scores: [{ graderId: "answer-match", metric: "answer_match", value: 1, pass: true, detail: "Example Domain" }],
      },
    ],
  },
  createdAt: now,
  updatedAt: now,
});

const runService = new RunService({ dispatcher: dummyDispatcher, store: runStore, newId: () => "bu-demo" });
const scorecardService = new ScorecardService({ store: scorecardStore, dispatch: async () => ({}), runner: {} });
const app = buildServer({ service: runService, scorecardService }); // ServerDeps.service = RunService
await app.listen({ port: 8787, host: "0.0.0.0" });
console.log("seed control-plane on :8787 — run bu-demo, scorecard bu-sc-demo (tenant=default, dev auth)");
