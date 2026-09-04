#!/usr/bin/env node
// THE EVOLUTION LOOP OVER A REAL BENCHMARK, THROUGH THE REAL DOORS.
//
// `scripts/live/evolution-campaign.mjs` drives the whole walk against a subject that needs no model. This one
// swaps in the expensive half: real SpreadsheetBench tasks, Claude Code inside the environment image, and a
// SELF-HOSTED RUNNER so the cases are dispatched into that image the way a workspace would run them — rather
// than by a shell loop standing beside the platform.
//
// What that changes, and why it is worth the wiring: the campaign record only means something if the rounds
// it holds came through `POST /scorecards`. A driver that computes a diff itself has measured the same
// numbers and produced no evidence anybody else can check.
//
// ── WHAT THIS NEEDS ─────────────────────────────────────────────────────────────────────────────────
//   · docker, and the environment image built:
//       docker build -t spreadsheetbench:v1 examples/bundles/spreadsheetbench
//       docker build -t spreadsheetbench-claude:v1 -f examples/bundles/spreadsheetbench/Dockerfile.claude \
//         examples/bundles/spreadsheetbench
//     …then an image carrying the staged tasks (see --data below).
//   · `claude` logged in on this machine. The runner lends that login to the job container with
//     --mount-claude-login; nothing is billed to an API key.
//   · apps/api/dist + apps/cli/dist built.
//
// ── WHAT IT REFUSES TO PRETEND ──────────────────────────────────────────────────────────────────────
// The answer workbooks are NOT in the image (see `sbench_digest.py`): the grader holds a salted digest, so
// the container the agent runs in cannot leak an oracle it does not contain. That is a substitute for a
// private verifier, which only the Nomad and K8s backends implement — stated here because a reader should not
// have to infer it from the absence of a `dispatchVerifier`.
//
// Usage:
//   node scripts/live/sbench-claude-campaign.mjs --data /path/to/stage --trials 3 [--image sbench-env:1.1.0]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const TASKS = arg("data", "");
const TRIALS = Number(arg("trials", "3"));
const IMAGE = arg("image", "sbench-env:1.1.0");
// ── A SMALL, TARGETED EXAM (frame-design.md, `targets`) ─────────────────────────────────────────────
// A round over fourteen cases at five trials is 140 containers and the better part of two hours, which is a
// loop nobody iterates on. Two things make it minutes instead, and neither weakens the verdict:
//   · `--cases` narrows the exam. A SMALLER exam is a WEAKER multiple-comparison correction, not a stronger
//     one — Benjamini-Hochberg ranks within the round's own cases, so rank 1 of 4 clears at (1/4)·alpha
//     where rank 1 of 14 needs (1/14)·alpha. The frozen family (`heldOutFamilySize`) is unchanged.
//   · `--targets` names the cases the campaign EXISTS to flip. The gate then requires every one of them to
//     improve significantly and the held-out block not to REGRESS — the "at least one held-out improvement"
//     rule is replaced, because a narrow, correct fix improves what it was asked to and nothing else.
// A target may not be held-out, and the schema refuses a frame that says otherwise: a case the loop is
// briefed on and optimizes against is not a generalization population.
const ONLY = (arg("cases", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TARGETS = (arg("targets", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const WORKERS = arg("workers", "4");
if (!TASKS) {
  console.error("--data <dir> is required: the staged tasks.json this image was built from.");
  process.exit(2);
}

const call = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, json: j };
};
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  return r.json;
};
const line = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 88 - s.length))}`);
const show = (l, v) =>
  console.log(`   ${l.padEnd(22)} ${typeof v === "string" ? v : String(JSON.stringify(v)).slice(0, 300)}`);

// The scaffold under evolution. The BASELINE says nothing about how to work; the CANDIDATE demands the
// verification loop the environment's own tool makes possible, and tells the agent that the sheet usually
// contains its own test — the worked examples the asker filled in before posting the question.
const PLAIN = "You are fixing spreadsheets. Apply the instruction to each workbook and save the outputs.";
const VERIFYING = `${PLAIN}

The reader opens your output with openpyxl data_only=True — it sees CACHED VALUES, so a formula that does not evaluate reads as an empty cell.

THE SHEET USUALLY CONTAINS ITS OWN TEST: the person who asked this question filled in the expected result for a few rows by hand. Before you write anything, note every row in the target column that ALREADY has a value, work out what rule produces exactly those, and check your formula against every one of them. If it disagrees with even one, the formula is wrong.

Then, for each workbook: apply the rule to EVERY row the data covers, save, run \`/opt/recalc.sh <file>\`, and run \`python3 /opt/sbcheck.py <file>\`. If it reports EMPTY rows or a formula that produced NO value, you are not done. Finish only when sbcheck reports no shape problems for all three outputs.`;

// ROUND 2. Round 1 told the agent that the sheet contains its own test; on the two targets it did not use it.
// Telling an agent to verify is not giving it something that verifies, so the environment gained the check
// (`/opt/sbexamples.py`, image 1.2.0) and this scaffold makes running it the finishing condition.
const EXAMPLE_CHECKED = `${VERIFYING}

THE SHEET'S OWN TEST IS A COMMAND YOU RUN, NOT A THING YOU REMEMBER. For every workbook:

    python3 /opt/sbexamples.py --input <the input> --output <your output> --range <the target range>

It compares your output against the rows the asker had ALREADY filled in — cells you can see, no answer
involved. If it says a worked example disagrees, your rule is wrong and the sheet can already prove it: fix
the rule and run it again. Do not finish until it reports that every worked example agrees for all three
workbooks, AND sbcheck reports no shape problems.

Passing it is necessary, not sufficient — the graded rows are the ones the asker left empty — so a rule that
merely reproduces the examples by special-casing them is worthless. Derive the rule, then check it.`;

const all = JSON.parse(readFileSync(`${TASKS}/tasks.json`, "utf8"));
const tasks = ONLY.length > 0 ? all.filter((t) => ONLY.includes(String(t.id))) : all;
if (ONLY.length > 0 && tasks.length !== ONLY.length) {
  console.error(`--cases named ${ONLY.length} ids and ${tasks.length} are in the data — refusing a partial exam.`);
  process.exit(2);
}
const caseFor = (t) => ({
  id: String(t.id),
  task:
    `Three Excel workbooks are in this directory: 1_${t.id}_input.xlsx, 2_${t.id}_input.xlsx and ` +
    `3_${t.id}_input.xlsx. Apply the instruction below to EACH of them and save the results here as ` +
    `1_${t.id}_output.xlsx, 2_${t.id}_output.xlsx and 3_${t.id}_output.xlsx.\n\n` +
    `INSTRUCTION: ${t.instruction}`,
  env: { kind: "repo", source: { files: {} } },
  image: IMAGE,
  // The grader runs the task's own verifier and reads the reward it PUBLISHES — never an exit code.
  //
  // ⚠️ IT GRADES IN PLACE, ON PURPOSE. A `files` or `env` key would make this a PRIVATE plan
  // (`PRIVATE_GRADER_CONFIG_KEYS`), and a self-hosted runner has no lane to run a verifier away from the
  // agent's container — so every case comes back `unmeasured: runtime 'self:…' cannot run a verifier away
  // from the agent's container`. Measured the expensive way: a first run of this script declared one and
  // produced 70 unmeasured results before the profile made it visible.
  //
  // The digest is what keeps the oracle out of the container, and it needs no private lane to do it: the
  // checker holds a salted hash, not an answer, so there is nothing to read even standing next to it.
  graders: [
    {
      id: "reward-file",
      config: {
        cmd: `bash -lc 'mkdir -p /tmp/everdict-reward; for f in *_output.xlsx; do [ -f "$f" ] && /opt/recalc.sh "$f" >/dev/null 2>&1; done; python3 /opt/sbench_digest.py --id ${t.id} --range ${JSON.stringify(t.answer_position)} --sheet ${JSON.stringify(t.answer_sheet ?? "")} --salt ${t.salt} --digests ${t.digests.join(",")} && echo 1.0 > /tmp/everdict-reward/reward.txt || echo 0.0 > /tmp/everdict-reward/reward.txt'`,
        rewardDir: "/tmp/everdict-reward",
        // WHERE THE HARNESS WORKED. `CommandHarness` runs in "work" (the repo env seeds there) and this
        // grader defaults to the image's own WORKDIR — so without this the checker looks in an empty
        // directory and reports every output "was not produced", which is indistinguishable from an agent
        // that produced nothing. Measured the expensive way, twice.
        cwd: "work",
      },
    },
  ],
  timeoutSec: 900,
  tags: ["spreadsheetbench", "cell-level"],
});

console.log(`=== ① control plane (dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
let runner;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  line("② pair this machine as a runner, and lend it the claude login");
  const paired = ok(await call("POST", "/runners", { label: "sbench-claude", capabilities: ["git"] }), "pair");
  const runnerId = paired.runner?.id;
  show("runner", runnerId);
  runner = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      paired.token,
      "--api-url",
      BASE,
      "--poll-interval-ms",
      "1000",
      // One runner, several cases at once. The default is 1 — serial — which is what made a round take two
      // hours; the scorecard's own `concurrency` parks the jobs and this is what decides how many actually run.
      "--max-concurrent",
      WORKERS,
      "--mount-claude-login",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  await sleep(3000);

  line("③ the world, as a registered environment version");
  for (const [version, image, description] of [
    ["1.0.0", "sbench-env:1.0.0", "SpreadsheetBench toolchain + Claude Code + the tasks, inputs only"],
    ["1.1.0", IMAGE, "…and /opt/sbcheck.py — self-inspection of a produced workbook (shape only, no answer)"],
  ]) {
    const r = await call("POST", "/environments", {
      id: "spreadsheetbench",
      version,
      description,
      env: { kind: "repo", source: { path: "/data" } },
      image,
    });
    show(
      `environment ${version}`,
      r.status === 201 ? "registered" : `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`,
    );
  }

  line("④ the harness family — one template, two scaffolds");
  ok(
    await call("POST", "/harness-templates", {
      kind: "command",
      category: "coding",
      id: "sbench-claude",
      version: "1.0.0",
      description: "Claude Code over a spreadsheet task; the scaffold is what a campaign evolves",
      setup: [],
      // The inputs are staged by the COMMAND rather than requested in the prompt: a task that asks the agent
      // to copy its own fixtures measures whether it read that sentence, which is not what this benchmark is
      // about. `{{case.id}}` is the allowed token that makes it per-case.
      command:
        "cp /data/{{case.id}}/*_input.xlsx . && " +
        'claude -p {{task}} --model "$CC_MODEL" --allowedTools "Read,Edit,Write,Bash" --max-turns "$CC_TURNS" ' +
        '--append-system-prompt "$CC_SCAFFOLD" --output-format json --dangerously-skip-permissions < /dev/null',
      env: { CC_MODEL: process.env.EVERDICT_CC_MODEL ?? "haiku", CC_TURNS: "40", CC_SCAFFOLD: PLAIN, IS_SANDBOX: "1" },
      params: {},
      trace: { kind: "none" },
    }),
    "template",
  );
  for (const [version, scaffold, description] of [
    ["1.0.0", PLAIN, "baseline: told what to do, nothing about how to check it"],
    ["1.1.0", VERIFYING, "candidate: the worked examples are the test, and sbcheck says what the reader sees"],
    ["1.2.0", EXAMPLE_CHECKED, "round 2: the sheet's own test is a command the agent must run, not remember"],
  ]) {
    const r = await call("POST", "/harnesses", {
      template: { id: "sbench-claude", version: "1.0.0" },
      id: "sbench-claude",
      version,
      description,
      pins: {},
      overrides: { env: { CC_SCAFFOLD: scaffold } },
    });
    show(`harness ${version}`, r.status === 201 ? "registered" : `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  }

  line(`⑤ the exam — ${tasks.length} real Cell-Level tasks`);
  const cases = tasks.map(caseFor);
  const ds = await call("POST", "/datasets", {
    id: "sbench-cell",
    version: "1.0.0",
    description: "SpreadsheetBench Cell-Level, scored against a salted digest of the answer",
    tags: ["spreadsheetbench"],
    cases,
  });
  show(
    "dataset",
    ds.status === 201 ? `${cases.length} cases` : `${ds.status} ${JSON.stringify(ds.json).slice(0, 200)}`,
  );

  line("⑥ the campaign — a frame frozen before either side runs");
  const issue = ok(
    await call("POST", "/issues", {
      title: "sbench-claude does not verify its own work",
      description: "The baseline scaffold produces workbooks nobody checked. The suspect is the scaffold.",
    }),
    "issue",
  );
  // Held-out is the last third BY ID ORDER — a rule fixed here, before either side has run, rather than a
  // split chosen once the numbers are in. Named TARGETS are excluded from it by construction, because the
  // schema refuses a frame whose target is also held-out and it is right to: a case the loop is briefed on
  // and optimizes against cannot also be the population that says whether it generalized.
  const ids = cases.map((c) => c.id).sort();
  const eligible = ids.filter((id) => !TARGETS.includes(id));
  const held = new Set(eligible.slice(Math.ceil((eligible.length * 2) / 3) - (TARGETS.length > 0 ? 0 : 0)));
  if (TARGETS.length > 0) {
    // With targets declared the held-out block is what must not REGRESS, so it takes every case that is
    // neither a target nor training — here, everything the targets leave.
    held.clear();
    for (const id of eligible.slice(Math.max(0, eligible.length - Math.max(2, Math.ceil(eligible.length / 2)))))
      held.add(id);
  }
  const missingTarget = TARGETS.filter((t) => !ids.includes(t));
  if (missingTarget.length > 0) {
    console.error(`--targets names ${missingTarget.join(", ")}, which the exam does not contain.`);
    process.exit(2);
  }
  const camp = ok(
    await call("POST", "/campaigns", {
      issueId: issue.id,
      frame: {
        subject: { type: "harness", id: "sbench-claude", baselineVersion: "1.0.0" },
        scenarios: ids.map((id) => ({ id, ...(held.has(id) ? { heldOut: true } : {}) })),
        ...(TARGETS.length > 0 ? { targets: TARGETS } : {}),
        trialsPerCase: TRIALS,
        budget: { maxRounds: 3 },
        significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 },
        // A self-hosted runner seals no world manifest, so every round reads `execution_world` unverified.
        // Declared because it is true of this lane and would not be on a managed one.
        allowUnverifiedIdentity: true,
      },
    }),
    "open campaign",
  );
  show("campaign", `${camp.id}  frame ${String(camp.frameDigest).slice(0, 24)}…`);
  show("held-out", [...held].join(", "));
  if (TARGETS.length > 0) show("targets", TARGETS.join(", "));

  const scorecard = async (version) => {
    const s = ok(
      await call("POST", "/scorecards", {
        dataset: { id: "sbench-cell", version: "1.0.0" },
        harness: { id: "sbench-claude", version },
        runtime: `self:${runnerId}`,
        trials: TRIALS,
        concurrency: 3,
      }),
      `scorecard ${version}`,
    );
    for (let i = 0; i < 4000; i++) {
      const r = ok(await call("GET", `/scorecards/${s.id}`), "poll");
      if (r.status !== "queued" && r.status !== "running") return { id: s.id, rec: r };
      await sleep(5000);
    }
    throw new Error("scorecard timed out");
  };
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

  line("⑦ baseline 1.0.0");
  const base = await scorecard("1.0.0");
  show("profile", profile(base.rec));

  const CANDIDATE_VERSION = arg("candidate", "1.1.0");
  line(`⑧ round — candidate ${CANDIDATE_VERSION}`);
  const cand = await scorecard(CANDIDATE_VERSION);
  show("profile", profile(cand.rec));

  const logged = await call("POST", `/campaigns/${camp.id}/rounds`, {
    hypothesis: "The scaffold, not the model, is what leaves the workbooks unchecked.",
    learned:
      "The sheet carries the asker's own worked examples, so an agent can test its rule without an oracle; " +
      "and the reader sees cached values, so a formula that does not evaluate is an empty cell whatever the " +
      "agent believes it wrote.",
    candidateVersion: CANDIDATE_VERSION,
    baselineScorecardId: base.id,
    candidateScorecardId: cand.id,
  });
  if (logged.status >= 300) {
    show("ROUND REFUSED", `${logged.status} ${String(logged.json?.message ?? "").slice(0, 300)}`);
  } else {
    // The verdict is the PLATFORM's — this script never sends one and the record would refuse it if it did.
    const v = logged.json.round?.verdict ?? (logged.json.rounds ?? []).at(-1)?.verdict ?? {};
    show("comparable", v.comparable);
    if (v.comparable === false) show("why not", v.detail);
    show("significant +/-", `${v.significantImprovements} / ${v.significantRegressions}`);
    show("heldOut", v.heldOut);
    if (v.targets) show("targets", v.targets);
    show("unverified axes", v.unverifiedAxes);
  }

  line("⑨ the gate, and the settlement it authorizes");
  const dec = ok(await call("GET", `/campaigns/${camp.id}/decision`), "decision");
  show("gate", dec);
  if (dec.kind !== "continue") {
    const settled = await call("POST", `/campaigns/${camp.id}/settle`, {});
    show("settle", `${settled.status} ${String(settled.json?.record?.state ?? settled.json?.message ?? "")}`);
    const adoption = ok(await call("GET", `/campaigns/${camp.id}/adoption`), "adoption");
    show("authorized", adoption.operation?.proof?.candidate ?? "nothing — this walk adopted no candidate");
  }
  console.log("\n✅ one walk, through the real doors: registered world, dispatched batches, derived verdict.");
} finally {
  runner?.kill("SIGTERM");
  cp.kill("SIGTERM");
}
