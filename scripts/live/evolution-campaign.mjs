#!/usr/bin/env node
// THE EVOLUTION LOOP, DRIVEN END TO END AGAINST A RUNNING CONTROL PLANE (skill `evolve`).
//
// The campaign record is a settlement, not an engine: it does not propose candidates, run scorecards or wake
// itself. So nothing in the unit suites drives the WALK — they drive the record. This script is the driver,
// and it exists because driving it for real is what found three defects the suites could not see: an override
// key the template could not apply was registered instead of refused, a round whose two sides ran the same
// bytes was recorded as a neutral finding, and a harness setup step ran with no env at all.
//
// It registers everything it needs, opens a campaign against a real issue, runs both sides as real batches,
// logs the round WITHOUT a verdict (the platform derives that), asks the gate, settles, and spends the
// adoption authorization — then probes the refusals that decide whether the record can be trusted.
//
// Two subjects:
//   default   `patchbot` — a command harness whose "agent" is a node script. No model, no key, no cost, a few
//             seconds. This is the one to run in a loop while changing the campaign code.
//   --claude  `cc-patcher` — real Claude Code over six multi-rule repo tasks, evolving the SCAFFOLD (tool
//             allowlist, turn budget, verification instruction). Needs `claude` on PATH and spends real model
//             budget: ~84 invocations at the default 7 trials. Measured once at ~$3.5 on haiku.
//
// Usage:
//   node apps/api/dist/main.js &                       # or any control plane
//   EVERDICT_API=http://127.0.0.1:8787 node scripts/live/evolution-campaign.mjs [--claude] [--trials 7]
import process from "node:process";

const API = process.env.EVERDICT_API ?? "http://127.0.0.1:8787";
const TOKEN = process.env.EVERDICT_TOKEN;
const H = {
  "content-type": "application/json",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : { "x-everdict-tenant": process.env.EVERDICT_TENANT ?? "acme" }),
};
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const CLAUDE = process.argv.includes("--claude");
const TRIALS = Number(arg("trials", CLAUDE ? "7" : "5"));
const RUNTIME = arg("runtime", "devhost");

const call = async (m, p, body) => {
  const r = await fetch(API + p, { method: m, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, body: j };
};
const ok = (r, what) => {
  if (r.status >= 300) {
    console.error(`✖ ${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
    process.exit(1);
  }
  return r.body;
};
const line = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 92 - s.length))}`);
const show = (l, v) =>
  console.log(`   ${l.padEnd(22)} ${typeof v === "string" ? v : String(JSON.stringify(v)).slice(0, 340)}`);

// ── THE NO-MODEL SUBJECT ────────────────────────────────────────────────────────────────────────────
// Four bug families, two cases each, and an "agent" whose strategy is the evolvable variation: `add` writes
// one operator whatever the test asks; `table` is a lookup keyed by CASE ID (the classic overfit — better on
// the cases somebody looked at, no better on anything else); `search` runs the failing test and tries the
// operator space until it passes.
const AGENT = `
const fs = require("fs");
const cp = require("child_process");
const strategy = process.env.PATCHBOT_STRATEGY || "add";
const budget = Number(process.env.PATCHBOT_BUDGET || "4");
const caseId = process.argv[2] || "";
const write = (body) => fs.writeFileSync("solve.js", "module.exports = (a, b) => " + body + ";\\n");
const passes = () => { try { cp.execSync("node test.js", { stdio: "pipe" }); return true; } catch { return false; } };
const CANDIDATES = ["a + b", "a * b", "Math.max(a, b)", "String(a) + String(b)"];
const TABLE = { "sum-1": "a + b", "sum-2": "a + b", "mul-1": "a * b", "mul-2": "a * b" };
if (strategy === "add") write("a + b");
else if (strategy === "table") write(TABLE[caseId] || "a + b");
else for (const c of CANDIDATES.slice(0, budget)) { write(c); if (passes()) break; }
`;
const FAMILIES = {
  sum: (a, b) => a + b,
  mul: (a, b) => a * b,
  max: (a, b) => Math.max(a, b),
  cat: (a, b) => String(a) + String(b),
};
const patchCase = (family, n, a, b) => ({
  id: `${family}-${n}`,
  task: "solve.js returns the wrong thing. Fix it so `node test.js` passes.",
  env: {
    kind: "repo",
    source: {
      files: {
        "solve.js": "module.exports = (a, b) => 0;\n",
        "test.js": `const f = require("./solve");\nconst got = f(${a}, ${b});\nif (got !== ${JSON.stringify(FAMILIES[family](a, b))}) { console.error("FAIL got=" + got); process.exit(1); }\nconsole.log("PASS");\n`,
      },
    },
  },
  graders: [{ id: "tests-pass", config: { cmd: "node test.js" } }],
  timeoutSec: 120,
  placement: { target: RUNTIME },
  tags: [family],
});

async function setupPatchbot() {
  ok(
    await call("POST", "/harness-templates", {
      kind: "command",
      category: "coding",
      id: "patchbot",
      version: "1.0.0",
      setup: [],
      // The agent is written by the COMMAND rather than by `setup`, which is where this script started: a setup
      // step used to run with no env at all, so `$PATCHBOT_SRC` expanded to nothing and every case looked like
      // an agent that did nothing. Fixed — and the command works either way.
      command: "printf '%s' \"$PATCHBOT_SRC\" > agent.js && node agent.js {{case.id}} {{task}}",
      env: { PATCHBOT_SRC: AGENT, PATCHBOT_STRATEGY: "add", PATCHBOT_BUDGET: "4" },
      params: {},
      trace: { kind: "none" },
    }),
    "patchbot template",
  );
  const v = (version, strategy, budget, description) => ({
    template: { id: "patchbot", version: "1.0.0" },
    id: "patchbot",
    version,
    description,
    pins: {},
    // `overrides.env` — NOT `overrides.command.env`, which the registry now refuses by name rather than
    // dropping (it used to register the template's own bytes under a new label).
    overrides: { env: { PATCHBOT_STRATEGY: strategy, PATCHBOT_BUDGET: String(budget) } },
  });
  ok(await call("POST", "/harnesses", v("1.0.0", "add", 4, "baseline: one operator, whatever the test asks")), "1.0.0");
  ok(await call("POST", "/harnesses", v("1.1.0", "table", 0, "candidate A: a lookup keyed by case id")), "1.1.0");
  ok(await call("POST", "/harnesses", v("1.2.0", "search", 4, "candidate B: runs the test and searches")), "1.2.0");
  ok(
    await call("POST", "/datasets", {
      id: "patchbench",
      version: "1.0.0",
      tags: ["evolution"],
      cases: [
        patchCase("sum", 1, 2, 3),
        patchCase("sum", 2, 10, 7),
        patchCase("mul", 1, 3, 4),
        patchCase("mul", 2, 6, 7),
        patchCase("max", 1, 9, 2),
        patchCase("max", 2, 4, 11),
        patchCase("cat", 1, 1, 2),
        patchCase("cat", 2, 8, 9),
      ],
    }),
    "patchbench",
  );
  return {
    harness: "patchbot",
    dataset: { id: "patchbench", version: "1.0.0" },
    baseline: "1.0.0",
    rounds: [
      {
        version: "1.1.0",
        hypothesis: "A lookup keyed by case id fixes the family the issue names.",
        learned:
          "It fixes exactly the cases it was written from — the held-out families are untouched, which is what a lookup is.",
      },
      {
        version: "1.2.0",
        hypothesis: "Running the failing test and searching the operator space generalizes.",
        learned:
          "The agent that verifies is the one that generalizes; the one that memorises improves only where it was pushed.",
      },
    ],
    scenarios: [
      { id: "sum-1" },
      { id: "sum-2" },
      { id: "mul-1" },
      { id: "mul-2" },
      { id: "max-1", heldOut: true },
      { id: "max-2", heldOut: true },
      { id: "cat-1", heldOut: true },
      { id: "cat-2", heldOut: true },
    ],
  };
}

// ── THE CLAUDE CODE SUBJECT ─────────────────────────────────────────────────────────────────────────
// Six modules whose spec lives only in their test, with several interacting rules each. What is evolved is
// the SCAFFOLD: the tool allowlist, the turn budget and what the agent is told finishing means. A first
// attempt at this benchmark was solved 6/6 by every scaffold and measured nothing — headroom is the hard part
// of authoring one, and the turn budget is what finally bound.
async function setupClaudeCode() {
  const { CC_CASES } = await import("./evolution-campaign-cases.mjs");
  ok(
    await call("POST", "/harness-templates", {
      kind: "command",
      category: "coding",
      id: "cc-patcher",
      version: "1.0.0",
      description: "Claude Code over a repo task; tools, turn budget and instructions are the scaffold",
      setup: [],
      // `< /dev/null` because `claude -p` waits three seconds for stdin it will never be given, and this
      // template is run ninety times.
      command:
        'claude -p {{task}} --model "$CC_MODEL" --allowedTools "$CC_TOOLS" --max-turns "$CC_TURNS" ' +
        '--append-system-prompt "$CC_SCAFFOLD" --output-format json --dangerously-skip-permissions < /dev/null',
      env: {
        CC_MODEL: process.env.EVERDICT_CC_MODEL ?? "haiku",
        CC_TOOLS: "Read,Edit,Write,Bash",
        CC_TURNS: "2",
        CC_SCAFFOLD: "You are fixing a small JavaScript module.",
        IS_SANDBOX: "1",
      },
      params: {},
      trace: { kind: "none" },
    }),
    "cc template",
  );
  const v = (version, turns, scaffold, description) => ({
    template: { id: "cc-patcher", version: "1.0.0" },
    id: "cc-patcher",
    version,
    description,
    pins: {},
    overrides: { env: { CC_TURNS: String(turns), CC_SCAFFOLD: scaffold } },
  });
  const PLAIN = "You are fixing a small JavaScript module.";
  ok(await call("POST", "/harnesses", v("2.0.0", 2, PLAIN, "baseline: two turns")), "2.0.0");
  ok(await call("POST", "/harnesses", v("2.1.0", 6, PLAIN, "candidate A: six turns")), "2.1.0");
  ok(
    await call(
      "POST",
      "/harnesses",
      v(
        "2.2.0",
        6,
        `${PLAIN} Before you finish you MUST run \`node test.js\` and read its output. If it does not print PASS, fix solve.js and run it again. Keep going until it prints PASS. Never edit test.js — it is the specification.`,
        "candidate B: six turns and a verification loop",
      ),
    ),
    "2.2.0",
  );
  ok(
    await call("POST", "/datasets", {
      id: "cc-patchbench",
      version: "1.0.0",
      tags: ["evolution"],
      cases: CC_CASES.map((c) => ({ ...c, placement: { target: RUNTIME } })),
    }),
    "cc-patchbench",
  );
  return {
    harness: "cc-patcher",
    dataset: { id: "cc-patchbench", version: "1.0.0" },
    baseline: "2.0.0",
    rounds: [
      {
        version: "2.1.0",
        hypothesis: "The scaffold's turn budget, not the model, is what stops the unsolved modules reaching PASS.",
        learned:
          "At two turns the agent reads the test and edits once, with nothing left to check the edit. Six turns is the same agent with room to look again.",
      },
      {
        version: "2.2.0",
        hypothesis: "Telling the agent what finishing means adds to what the budget already bought.",
        learned: "Measured after the budget round, so whatever this shows is about the instruction alone.",
      },
    ],
    // The held-out split is the last three case ids ALPHABETICALLY — a rule fixed before the frame, not a
    // choice made after seeing which cases moved.
    scenarios: CC_CASES.map((c) => c.id)
      .sort()
      .map((id, i) => (i >= 3 ? { id, heldOut: true } : { id })),
  };
}

async function scorecard(plan, version) {
  const t0 = Date.now();
  const s = ok(
    await call("POST", "/scorecards", {
      dataset: plan.dataset,
      harness: { id: plan.harness, version },
      runtime: RUNTIME,
      trials: TRIALS,
      concurrency: CLAUDE ? 3 : 4,
    }),
    `scorecard ${version}`,
  );
  for (;;) {
    const r = ok(await call("GET", `/scorecards/${s.id}`), "poll");
    if (r.status !== "queued" && r.status !== "running") return { id: s.id, rec: r, ms: Date.now() - t0 };
    await new Promise((x) => setTimeout(x, 3000));
  }
}
const profile = (rec) => {
  const per = new Map();
  for (const c of rec.scorecard?.results ?? rec.results ?? []) {
    const pass = (c.scores ?? []).some((x) => x.metric === "tests_pass" && x.pass === true);
    const e = per.get(c.caseId) ?? { pass: 0, n: 0 };
    e.n += 1;
    if (pass) e.pass += 1;
    per.set(c.caseId, e);
  }
  const rows = [...per.entries()].sort();
  const [p, n] = rows.reduce(([a, b], [, e]) => [a + e.pass, b + e.n], [0, 0]);
  return `${rows.map(([id, e]) => `${id}:${e.pass}/${e.n}`).join("  ")}   ⟶ ${p}/${n}`;
};

const plan = CLAUDE ? await setupClaudeCode() : await setupPatchbot();
ok(await call("POST", "/runtimes", { kind: "local", id: RUNTIME, version: "1.0.0", tags: [] }), "runtime").id;
show("subject", `${plan.harness}@${plan.baseline}  ·  ${plan.dataset.id}@${plan.dataset.version}  ·  ${TRIALS} trials`);

const issue = ok(
  await call("POST", "/issues", {
    title: `${plan.harness}: the scaffold is the suspect, not the model`,
    description: "Opened by scripts/live/evolution-campaign.mjs to drive one walk end to end.",
  }),
  "issue",
);
const camp = ok(
  await call("POST", "/campaigns", {
    issueId: issue.id,
    frame: {
      subject: { type: "harness", id: plan.harness, baselineVersion: plan.baseline },
      scenarios: plan.scenarios,
      trialsPerCase: TRIALS,
      budget: { maxRounds: 3 },
      // Pick N and the family from the bar a round will actually face: BH ranks the round's cases at
      // fdrAlpha/heldOutFamilySize, so k movers out of m scenarios face (k/m)·alpha. See the frame reference.
      significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 },
      // A `local` runtime seals no world manifest, so every round reads `execution_world` unverified. True of
      // this lane, and not something to declare on a managed one.
      allowUnverifiedIdentity: true,
    },
  }),
  "open campaign",
);
show("campaign", `${camp.id}  frame ${String(camp.frameDigest).slice(0, 24)}…`);

line(`baseline ${plan.baseline}`);
const base = await scorecard(plan, plan.baseline);
show("elapsed", `${(base.ms / 1000).toFixed(0)}s`);
show("profile", profile(base.rec));

for (const round of plan.rounds) {
  line(`round — candidate ${round.version}`);
  const cand = await scorecard(plan, round.version);
  show("elapsed", `${(cand.ms / 1000).toFixed(0)}s`);
  show("profile", profile(cand.rec));
  const logged = await call("POST", `/campaigns/${camp.id}/rounds`, {
    hypothesis: round.hypothesis,
    learned: round.learned,
    candidateVersion: round.version,
    baselineScorecardId: base.id,
    candidateScorecardId: cand.id,
  });
  if (logged.status >= 300) {
    show("ROUND REFUSED", `${logged.status} ${String(logged.body?.message ?? "").slice(0, 220)}`);
    break;
  }
  // The verdict is the PLATFORM's — this script never sends one, and the record would refuse it if it did.
  const verdict = logged.body.round?.verdict ?? (logged.body.rounds ?? []).at(-1)?.verdict ?? {};
  show("comparable", verdict.comparable);
  if (verdict.comparable === false) show("why not", verdict.detail);
  show("significant +/-", `${verdict.significantImprovements} / ${verdict.significantRegressions}`);
  show("heldOut", verdict.heldOut);
  show("unverified axes", verdict.unverifiedAxes);
  const decision = ok(await call("GET", `/campaigns/${camp.id}/decision`), "decision");
  show("gate", decision);
  if (decision.kind !== "continue") break;
  // The gate says continue, so settling now must be refused: a campaign settles on an adoptable candidate or
  // on its own ending, never in the middle.
  const early = await call("POST", `/campaigns/${camp.id}/settle`, {});
  show("settle mid-walk", `${early.status} ${String(early.body?.message ?? "").slice(0, 120)}`);
}

line("closing");
const settled = await call("POST", `/campaigns/${camp.id}/settle`, {});
show("settle", `${settled.status} ${String(settled.body?.record?.state ?? settled.body?.message ?? "")}`);
const adoption = ok(await call("GET", `/campaigns/${camp.id}/adoption`), "adoption");
show("state", adoption.state);
const proof = adoption.operation?.proof;
if (proof === undefined) {
  show("authorized", "nothing — this walk ended without an adoptable candidate");
  process.exit(0);
}
show("authorized", proof.candidate);

line("what an authorization is NOT");
const forged = await call("POST", `/campaigns/${camp.id}/adopt`, {
  proof: { ...proof, candidate: { ...proof.candidate, version: "9.9.9" } },
  spec: { template: { id: plan.harness, version: "1.0.0" }, id: plan.harness, version: "9.9.9", pins: {} },
});
show("a forged proof", `${forged.status} ${String(forged.body?.message ?? "").slice(0, 140)}`);
const instance = ok(await call("GET", `/harnesses/${plan.harness}/${proof.candidate.version}/instance`), "instance");
const relabelled = await call("POST", `/campaigns/${camp.id}/adopt`, {
  proof,
  spec: { ...instance, version: "9.9.9" },
});
show("a spec it did not judge", `${relabelled.status} ${String(relabelled.body?.message ?? "").slice(0, 160)}`);

line("spending it");
const spent = await call("POST", `/campaigns/${camp.id}/adopt`, { proof, spec: instance });
show("adopt", `${spent.status} ${String(spent.body?.kind ?? spent.body?.message ?? "")}`);
show("operation", ok(await call("GET", `/campaigns/${camp.id}/adoption`), "after").operation?.state);
console.log(
  "\n✅ one walk: opened against an issue, rounds derived by the platform, settled, and the authorization spent.",
);
