// live (web full-stack visual check): seed *representative browser-use run/scorecard records* into the real control-plane HTTP surface (buildServer)
// and serve on :8787 → a seed server for confirming that the web dashboard (next, CONTROL_PLANE_URL defaults to 127.0.0.1:8787, KEYCLOAK unset = dev tenant)
// actually renders the browser snapshot (final URL + DOM) + scores (steps/cost) + trace.
// The record values are representative values taken from this session's real browser-use run (Wikipedia 'Web scraping', tokens 35872/1074, usd 0.006025, navigate →
// input → click → done) — seeded directly into the store instead of a POST dispatch (intent of the request: seed a run record).
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

// two scorecards for the comparison (diff) — same cases (form-everdict, hard-task), gpt5.4 fixes (improves) hard-task + a cost delta.
// (representative values: the common A/B pattern of a stronger model passing a harder case — for checking the compare view's regression/improvement and metric-delta rendering.)
const browserSnap = (url, dom) => ({ kind: "browser", url, dom, console: [] });
const caseResult = (caseId, pass, usd) => ({
  caseId,
  harness: "browseruse",
  trace: [],
  snapshot: browserSnap("https://en.wikipedia.org/wiki/Web_scraping", "..."),
  scores: [
    { graderId: "answer-match", metric: "answer_match", value: pass ? 1 : 0, pass },
    { graderId: "cost", metric: "usd", value: usd },
  ],
});
const scMeta = (id, version, summary, results) => ({
  id,
  tenant: "default",
  dataset: { id: "webvoyager-sample", version: "v1" },
  harness: { id: "browseruse", version },
  status: "succeeded",
  summary,
  scorecard: { suiteId: "webvoyager-sample", harness: `browseruse@${version}`, results },
  createdAt: now,
  updatedAt: now,
});
await scorecardStore.create(
  scMeta(
    "bu-sc-mini",
    "mini",
    [
      { metric: "answer_match", count: 2, mean: 0.5, passRate: 0.5 },
      { metric: "usd", count: 2, mean: 0.0035 },
    ],
    [caseResult("form-everdict", true, 0.003), caseResult("hard-task", false, 0.004)],
  ),
);
await scorecardStore.create(
  scMeta(
    "bu-sc-gpt54",
    "gpt5.4",
    [
      { metric: "answer_match", count: 2, mean: 1, passRate: 1 },
      { metric: "usd", count: 2, mean: 0.00575 },
    ],
    [caseResult("form-everdict", true, 0.0035), caseResult("hard-task", true, 0.008)],
  ),
);

// desktop (OSWorld) scorecard — the desktop track of the unified report. state (file-creation check)=PASS / judge (screenshot)=FAIL →
// the authoritative caseVerdict follows state, so the case is PASS (ground-truth wins even if the VLM cannot be sure the file was saved to disk).
await scorecardStore.create({
  id: "bu-sc-osworld",
  tenant: "default",
  dataset: { id: "osworld-sample", version: "v1" },
  harness: { id: "desktop-osworld", version: "1.0.0" },
  status: "succeeded",
  summary: [
    { metric: "state", count: 1, mean: 1, passRate: 1 },
    { metric: "judge", count: 1, mean: 0.78, passRate: 0 },
  ],
  scorecard: {
    suiteId: "osworld-sample",
    harness: "desktop-osworld@1.0.0",
    results: [
      {
        caseId: "writer-note",
        harness: "desktop-osworld@1.0.0",
        trace: [],
        snapshot: { kind: "os-use", screenshotRef: "", screenshot: "", windows: [] },
        scores: [
          {
            graderId: "judge",
            metric: "judge",
            value: 0.78,
            pass: false,
            detail: "cannot be sure of disk save from the screenshot alone.",
          },
          {
            graderId: "command",
            metric: "state",
            value: 1,
            pass: true,
            detail: "test -f /root/note.txt && grep → file existence confirmed",
          },
        ],
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
