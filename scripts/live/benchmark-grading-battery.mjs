// Live experiment: can Everdict's CODE JUDGE (a python/node script over the full GradeContext) express the ACTUAL
// grading spec that real open agent benchmarks require? We encode each benchmark's real scoring function as a code
// judge and run it through the real engine on a CORRECT and an INCORRECT agent output, asserting the judge
// discriminates exactly as the benchmark does (correct → pass, incorrect → fail) — a grader that always passes is
// worthless, so discrimination is the bar.
//
// Benchmarks encoded (grading paradigm → code judge):
//   GAIA      — normalized quasi-exact-match of the final answer (number/string/list normalization, the official
//               question_scorer). Signal: the agent's answer. → code judge over the trace + case.expected.
//   WebArena  — functional eval: url_match + string_match(must_include) + program_html(element contents). Signal:
//               final URL + rendered DOM. → code judge over a browser-like payload (the front-door now supplies a
//               real DOM; see fix(topology) capture the real page DOM).
//   tau-bench — reward = required tool actions taken AND final data (DB) state matches. Signal: the tool-call
//               trajectory + end state. → code judge over the action list + state.
//
// Each benchmark's dataset has a `good` case (should PASS) and a `bad` case (should FAIL). The command harness echoes
// each case's payload (the simulated agent output) as the trace; the code judge parses it and applies the benchmark's
// real criterion. No docker, no LLM (these graders are deterministic — exactly like the real benchmark scorers).
//
// Usage: node scripts/live/benchmark-grading-battery.mjs   (apps/api/dist + apps/cli/dist built).
import { spawn } from "node:child_process";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8815";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

// ── the benchmark grading functions, each a faithful code judge (python) ─────────────────────────────────────────
// The harness echoes the case payload as the agent's final message; the judge parses it and grades. Metric prefix
// `judge` → judge:<id>. The judge emits pass/fail + a reason (the benchmark's verdict + why).

// GAIA — the official question_scorer: number normalization (strip $,%,commas) OR string normalization (lowercase,
// strip articles/punctuation) OR list (comma-split, element-wise). pass iff normalized(answer) == normalized(gt).
const GAIA_JUDGE = `
import json, sys, re, string
ctx = json.load(open(sys.argv[1]))
p = {}
for e in reversed(ctx.get("trace", [])):
    if e.get("kind") == "message" and e.get("role") == "assistant":
        try: p = json.loads(str(e.get("text","")).strip()); break
        except Exception: pass
answer, gt = str(p.get("answer","")), str(p.get("expected",""))
def norm_number(s):
    s = s.replace("$","").replace("%","").replace(",","").strip()
    try: return float(s)
    except Exception: return None
def norm_str(s, keep_punct=False):
    s = s.lower().strip()
    if not keep_punct: s = s.translate(str.maketrans("", "", string.punctuation))
    s = re.sub(r"\\b(a|an|the)\\b", " ", s)
    return re.sub(r"\\s+", " ", s).strip()
def score_one(a, g):
    na, ng = norm_number(a), norm_number(g)
    if na is not None and ng is not None: return abs(na - ng) < 1e-6
    return norm_str(a) == norm_str(g)
# list answers: comma-separated, element-wise (GAIA split_string)
if "," in gt:
    al = [x for x in re.split(r"[,;]", answer) if x.strip()]
    gl = [x for x in re.split(r"[,;]", gt) if x.strip()]
    ok = len(al) == len(gl) and all(score_one(a, g) for a, g in zip(al, gl))
else:
    ok = score_one(answer, gt)
print(json.dumps([{ "graderId":"judge","metric":"judge","value":1 if ok else 0,"pass":ok,
  "detail": f"GAIA quasi-exact-match: answer={answer!r} vs gt={gt!r} → {'match' if ok else 'mismatch'}" }]))
`.trim();

// WebArena — url_match (exact path OR GET-param subset) + string_match(must_include over answer+dom) +
// program_html (locate an element by id=/text and check required_contents). pass iff every configured check passes.
const WEBARENA_JUDGE = `
import json, sys, re
from urllib.parse import urlparse, parse_qs
ctx = json.load(open(sys.argv[1]))
p = {}
for e in reversed(ctx.get("trace", [])):
    if e.get("kind") == "message" and e.get("role") == "assistant":
        try: p = json.loads(str(e.get("text","")).strip()); break
        except Exception: pass
url, dom, answer = str(p.get("url","")), str(p.get("dom","")), str(p.get("answer",""))
ev = p.get("eval", {})
reasons, ok = [], True
# URLEvaluator
if "reference_url" in ev:
    ref = ev["reference_url"]; mode = ev.get("url_note","exact")
    if mode == "GET":
        want = parse_qs(urlparse(ref).query); got = parse_qs(urlparse(url).query)
        u_ok = all(got.get(k) == v for k, v in want.items())
    else:
        u_ok = urlparse(url).path.rstrip("/") == urlparse(ref).path.rstrip("/")
    reasons.append(f"url_match({mode})={'PASS' if u_ok else 'FAIL'}"); ok = ok and u_ok
# StringEvaluator must_include (over the answer AND the page dom, case-insensitive — WebArena checks the response)
if "must_include" in ev:
    hay = (answer + " " + dom).lower()
    s_ok = all(str(x).lower() in hay for x in ev["must_include"])
    reasons.append(f"string_match(must_include)={'PASS' if s_ok else 'FAIL'}"); ok = ok and s_ok
# HTMLContentEvaluator program_html — locate an element (id= locator) and check required_contents
if "program_html" in ev:
    for t in ev["program_html"]:
        loc = t.get("locator",""); req = str(t.get("required_contents",""))
        # extract the element's text after the id match (simple locator: id=<name>)
        if loc.startswith("id="):
            idv = loc.split("=",1)[1]
            em = re.search(r'id=["\\']?' + re.escape(idv) + r'["\\']?[^>]*>([^<]*)<', dom)
            text = em.group(1) if em else ""
        else:
            text = dom
        h_ok = req.lower() in text.lower()
        reasons.append(f"program_html({loc})={'PASS' if h_ok else 'FAIL'}"); ok = ok and h_ok
print(json.dumps([{ "graderId":"judge","metric":"judge","value":1 if ok else 0,"pass":ok,
  "detail": "WebArena functional eval: " + "; ".join(reasons) }]))
`.trim();

// tau-bench — reward = required tool actions all taken (subset) AND final data state matches the expected writes.
const TAUBENCH_JUDGE = `
import json, sys
ctx = json.load(open(sys.argv[1]))
p = {}
for e in reversed(ctx.get("trace", [])):
    if e.get("kind") == "message" and e.get("role") == "assistant":
        try: p = json.loads(str(e.get("text","")).strip()); break
        except Exception: pass
actions = p.get("actions", []); state = p.get("db_state", {}); ev = p.get("eval", {})
req = ev.get("required_actions", []); exp_state = ev.get("expected_state", {})
a_ok = all(a in actions for a in req)                       # r_actions: required writes all present
s_ok = all(state.get(k) == v for k, v in exp_state.items()) # r_outputs: end DB state matches
ok = a_ok and s_ok
print(json.dumps([{ "graderId":"judge","metric":"judge","value":1 if ok else 0,"pass":ok,
  "detail": f"tau-bench reward: actions {'✓' if a_ok else '✗'} (need {req}, got {actions}), state {'✓' if s_ok else '✗'}" }]))
`.trim();

// ── the benchmark datasets: a good case (PASS) + a bad case (FAIL) per benchmark ─────────────────────────────────
const BENCHMARKS = [
  {
    id: "gaia",
    judge: GAIA_JUDGE,
    good: { answer: "$1,024.50", expected: "1024.5" }, // number normalization: $ , stripped → equal
    bad: { answer: "the blue whale", expected: "elephant" }, // string mismatch
    goodWhy: "number normalization ($/comma) → 1024.5 == 1024.5",
    badWhy: "wrong answer",
  },
  {
    id: "webarena",
    judge: WEBARENA_JUDGE,
    good: {
      url: "https://shop.example/order/success?id=42",
      dom: '<html><body><h1>Thank you</h1><span id="status">Order confirmed</span></body></html>',
      answer: "Your order #42 is confirmed.",
      eval: {
        reference_url: "https://shop.example/order/success?id=42",
        url_note: "GET",
        must_include: ["confirmed", "#42"],
        program_html: [{ locator: "id=status", required_contents: "Order confirmed" }],
      },
    },
    bad: {
      url: "https://shop.example/cart",
      dom: '<html><body><span id="status">Items in cart</span></body></html>',
      answer: "Still in the cart.",
      eval: {
        reference_url: "https://shop.example/order/success?id=42",
        url_note: "GET",
        must_include: ["confirmed", "#42"],
        program_html: [{ locator: "id=status", required_contents: "Order confirmed" }],
      },
    },
    goodWhy: "url GET-param + must_include + program_html all pass",
    badWhy: "wrong url, missing strings, element text mismatch",
  },
  {
    id: "taubench",
    judge: TAUBENCH_JUDGE,
    good: {
      actions: ["find_reservation", "cancel_flight", "refund_card"],
      db_state: { reservation_status: "cancelled", refund: 300 },
      eval: {
        required_actions: ["cancel_flight", "refund_card"],
        expected_state: { reservation_status: "cancelled", refund: 300 },
      },
    },
    bad: {
      actions: ["find_reservation"], // never cancelled/refunded
      db_state: { reservation_status: "active", refund: 0 },
      eval: {
        required_actions: ["cancel_flight", "refund_card"],
        expected_state: { reservation_status: "cancelled", refund: 300 },
      },
    },
    goodWhy: "required actions taken + end state matches",
    badWhy: "missing cancel/refund actions + wrong end state",
  },
];

console.log(`=== control plane (:${PORT}) + self-hosted runner ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "ignore", "pipe"],
});
cp.stderr.on("data", (d) => {
  const s = String(d);
  if (/error|unhandled/i.test(s)) process.stderr.write(`  [cp] ${s}`);
});
let runner;
let ok = false;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  const paired = await post("/runners", { label: "bench-battery", capabilities: ["git"] });
  const runnerId = paired.json.runner.id;
  runner = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      paired.json.token,
      "--api-url",
      BASE,
      "--poll-interval-ms",
      "400",
      "--max-concurrent",
      "4",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] },
  );
  await sleep(3000);

  // one echo-agent harness — echoes each case's payload (the simulated agent output) as the trace's assistant message.
  await post("/harness-templates", {
    kind: "command",
    category: "cli-agent",
    id: "echo-agent",
    version: "1",
    setup: [],
    command: "printf '%s' {{task}}", // {{task}} = the per-case JSON payload (shq-quoted by the harness)
    env: {},
    trace: { kind: "none" },
  });
  await post("/harnesses", {
    template: { id: "echo-agent", version: "1" },
    id: "echo-agent",
    version: "1.0.0",
    pins: {},
  });

  for (const b of BENCHMARKS) {
    console.log(`\n=== ${b.id.toUpperCase()} — encode the real grading spec as a code judge ===`);
    await post("/judges", { kind: "code", id: `bench-${b.id}`, version: "1", language: "python", code: b.judge });
    await post("/datasets", {
      id: `${b.id}-ds`,
      version: "1.0.0",
      cases: [
        {
          id: "good",
          env: { kind: "repo", source: { files: {} } },
          task: JSON.stringify(b.good),
          expected: JSON.stringify(b.good.expected ?? ""),
          graders: [{ id: "tests-pass", config: { cmd: "true" } }],
          timeoutSec: 60,
          tags: [b.id],
        },
        {
          id: "bad",
          env: { kind: "repo", source: { files: {} } },
          task: JSON.stringify(b.bad),
          expected: JSON.stringify(b.bad.expected ?? ""),
          graders: [{ id: "tests-pass", config: { cmd: "true" } }],
          timeoutSec: 60,
          tags: [b.id],
        },
      ],
    });
    const sub = await post("/scorecards", {
      dataset: { id: `${b.id}-ds`, version: "1.0.0" },
      harness: { id: "echo-agent" },
      runtime: `self:${runnerId}`,
      concurrency: 2,
      judges: [{ id: `bench-${b.id}`, version: "1" }],
    });
    if (!sub.json.id) throw new Error(`submit ${b.id} failed: ${JSON.stringify(sub.json)}`);
    let rec;
    for (let i = 0; i < 120; i++) {
      await sleep(1500);
      rec = await get(`/scorecards/${sub.json.id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    if (rec.status !== "succeeded") throw new Error(`${b.id} scorecard ${rec.status}`);
    const results = rec.scorecard?.results ?? [];
    const scoreOf = (caseId) =>
      (results.find((r) => r.caseId === caseId)?.scores ?? []).find((s) => s.metric === `judge:bench-${b.id}`);
    const goodScore = scoreOf("good");
    const badScore = scoreOf("bad");
    check(goodScore?.pass === true, `${b.id}: CORRECT output → judge PASS (${b.goodWhy})`);
    check(badScore?.pass === false, `${b.id}: INCORRECT output → judge FAIL (${b.badWhy})`);
    check(
      String(goodScore?.detail ?? "").length > 10 && String(badScore?.detail ?? "").length > 10,
      `${b.id}: judge emits the benchmark verdict + reason`,
    );
    console.log(`  good → ${goodScore?.pass ? "PASS" : "FAIL"} :: ${String(goodScore?.detail ?? "").slice(0, 110)}`);
    console.log(`  bad  → ${badScore?.pass ? "PASS" : "FAIL"} :: ${String(badScore?.detail ?? "").slice(0, 110)}`);
  }

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — the code judge expressed each benchmark's real grading spec (GAIA quasi-exact-match, WebArena url/string/program_html functional eval, tau-bench action+state reward) and discriminated correct from incorrect outputs exactly as the benchmark does."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  try {
    runner?.kill("SIGKILL");
  } catch {}
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
