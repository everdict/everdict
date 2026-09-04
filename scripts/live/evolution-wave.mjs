#!/usr/bin/env node
// SEVERAL CAMPAIGNS AT ONCE, AND THE ONE THING THAT MAY CROSS BETWEEN THEM.
//
// `sbench-claude-campaign.mjs` walks ONE campaign. This drives a TREE of them — several issues, each naming
// the cases it exists to flip, each opened as its own campaign, advanced wave by wave until the gates settle
// or the round budget runs out. It is `docs/architecture/parallel-evolution.md` executed.
//
// ── WHAT CROSSES A BRANCH BOUNDARY, AND WHAT MAY NOT ────────────────────────────────────────────────
//
// Findings do; evidence does not. Every round's `learned` is harvested into a WIKI after each wave, and the
// next wave's proposal reads it — which is safe because the gate does not read `learned` and cannot, so a
// finding can shape a proposal and can never become the evidence that adopts it. That split is not this
// script's invention: it is WikiSkill's measured result (the same knowledge to the proposer, +15.0; also to
// the executing agent, −2.8), and the repo's own law that a loop may not write its own report card.
//
// It is not free, which is why every round declares `informedBy`. Branches that read each other converge, and
// correlated branches spend the same pre-registered held-out family while asking fewer distinct questions —
// so the record says which campaigns a proposal was shaped by, and a reader can see the correlation instead
// of mistaking two rows for independent evidence.
//
// ── WHAT MAKES THIS HONEST RATHER THAN FAST ─────────────────────────────────────────────────────────
//
//   · Each campaign's exam, targets and held-out block are FROZEN at open, before any candidate runs.
//   · Held-out cases are chosen so the change under test cannot reach them (see `--plan`), and no case in a
//     held-out block is ever opened, diagnosed or read by this driver.
//   · The candidate is a SCAFFOLD — what the agent is told and what the environment gives it. No case data,
//     no answer, no per-case special-casing: a strategy that named a task would be measuring itself.
//   · The verdict is the platform's. This script logs rounds and never sends one.
//
// Usage:
//   node scripts/live/evolution-wave.mjs --plan <plan.json> --data <stage> --image <img> [--max-rounds 10]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8820";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const PLAN = JSON.parse(readFileSync(arg("plan", ""), "utf8"));
const TASKS = arg("data", "");
const IMAGE = arg("image", "sbench-env:1.2.0");
const TRIALS = Number(arg("trials", "6"));
const MAX_ROUNDS = Number(arg("max-rounds", "10"));
const WORKERS = arg("workers", "4");
const WIKI = arg("wiki", "/tmp/claude-1000/evolution-wiki.md");

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
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
};
const line = (s) => console.log(`\n${"═".repeat(4)} ${s} ${"═".repeat(Math.max(0, 84 - s.length))}`);
const show = (l, v) =>
  console.log(`   ${l.padEnd(20)} ${typeof v === "string" ? v : String(JSON.stringify(v)).slice(0, 260)}`);

// ── THE STRATEGY LIBRARY ────────────────────────────────────────────────────────────────────────────
//
// Every entry is a HARNESS change aimed at a failure mode this benchmark was measured to have, and every one
// is general: none names a task, a range or a value. `needs` is what the environment must provide for the
// strategy to be runnable at all, so a scaffold that tells an agent to run a tool the image lacks is refused
// here rather than measured as a failure of the idea.
const BASE_PROMPT = "You are fixing spreadsheets. Apply the instruction to each workbook and save the outputs.";
const READER =
  "The reader opens your output with openpyxl data_only=True — it sees CACHED VALUES, so a formula that does not evaluate reads as an empty cell.";
const STRATEGIES = {
  shape: {
    summary: "make the reader's view checkable: recalc, then ask the tool what it sees",
    needs: ["sbcheck"],
    scaffold: `${BASE_PROMPT}

${READER}

For EACH workbook: apply the rule to every row the data covers, save, run \`/opt/recalc.sh <file>\`, then \`python3 /opt/sbcheck.py <file>\`. If it reports EMPTY rows or a formula that produced NO value, you are not done — fill them, or replace the unevaluatable formula with its computed value, and repeat. Finish only when it reports no shape problems for all three outputs.`,
  },
  examples_told: {
    summary: "tell the agent the sheet usually carries the asker's own worked examples",
    needs: [],
    scaffold: `${BASE_PROMPT}

${READER}

THE SHEET OFTEN CONTAINS ITS OWN TEST: the person who asked this question filled in the expected result for a few rows by hand. Note every row in the target column that ALREADY has a value, work out what rule produces exactly those, and check your rule against every one of them before applying it to the rest.`,
  },
  examples_run: {
    summary: "make checking the worked examples a command the agent must run, not a thing it may remember",
    needs: ["sbexamples"],
    scaffold: `${BASE_PROMPT}

${READER}

THE SHEET'S OWN TEST IS A COMMAND YOU RUN:

    python3 /opt/sbexamples.py --input <input> --output <your output> --range <the target range>

It compares your output against the rows the asker had ALREADY filled in — your own two files, no answer involved. If a worked example disagrees, your rule is wrong and the sheet can prove it: fix the rule and run it again. Do not finish until every worked example agrees for all three workbooks.

Passing it is necessary, not sufficient — the graded rows are the ones the asker left EMPTY — so a rule that reproduces the examples by special-casing them is worthless. Derive the rule, then check it.`,
  },
  values_not_formulas: {
    summary: "write computed VALUES where a formula the reader cannot evaluate would leave an empty cell",
    needs: ["sbcheck"],
    scaffold: `${BASE_PROMPT}

${READER}

So prefer a COMPUTED VALUE over a formula whenever you are not certain the formula will evaluate: read the data with openpyxl, compute each cell in Python, and write the number. A formula that LibreOffice cannot evaluate is an empty cell to the reader however correct it looks in the file.

After saving, run \`/opt/recalc.sh <file>\` then \`python3 /opt/sbcheck.py <file>\`, and fix anything it reports as producing no value.`,
  },
  rederive_per_workbook: {
    summary: "re-derive the rule from EACH workbook rather than carrying one across all three",
    needs: [],
    scaffold: `${BASE_PROMPT}

${READER}

THE THREE WORKBOOKS ARE THREE DIFFERENT DATA SETS. Treat each one independently: read ITS data, derive the rule from ITS rows, apply it, and check it against ITS own filled-in rows. A rule that was right for the first workbook can be wrong for the second — carrying one across without re-checking is the commonest way these tasks are failed.`,
  },
  state_the_rule: {
    summary: "state the rule in words and justify it against the data before writing anything",
    needs: [],
    scaffold: `${BASE_PROMPT}

${READER}

BEFORE YOU EDIT ANYTHING, write down in one sentence what rule produces the target column from the other columns, and name the rows in the data that make you believe it. Only then apply it. If you cannot state the rule without looking at what you already wrote, you do not have one yet.`,
  },
};

// ── SETUP ───────────────────────────────────────────────────────────────────────────────────────────
console.log(`=== control plane (dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => void d);
let runner;
const wiki = [];
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  const paired = ok(await call("POST", "/runners", { label: "wave", capabilities: ["git"] }), "pair");
  const runnerId = paired.runner?.id;
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
      "--max-concurrent",
      WORKERS,
      "--mount-claude-login",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => void d);
  await sleep(3000);
  show("runner", `${runnerId} · ${WORKERS} workers`);

  ok(
    await call("POST", "/environments", {
      id: "spreadsheetbench",
      version: PLAN.environment.version,
      description: PLAN.environment.description,
      env: { kind: "repo", source: { path: "/data" } },
      image: IMAGE,
    }),
    "environment",
  );
  ok(
    await call("POST", "/harness-templates", {
      kind: "command",
      category: "coding",
      id: "sbench-claude",
      version: "1.0.0",
      description: "Claude Code over a spreadsheet task; the scaffold is what a campaign evolves",
      setup: [],
      command:
        "cp /data/{{case.id}}/*_input.xlsx . && " +
        'claude -p {{task}} --model "$CC_MODEL" --allowedTools "Read,Edit,Write,Bash" --max-turns "$CC_TURNS" ' +
        '--append-system-prompt "$CC_SCAFFOLD" --output-format json --dangerously-skip-permissions < /dev/null',
      env: {
        CC_MODEL: process.env.EVERDICT_CC_MODEL ?? "haiku",
        CC_TURNS: "40",
        CC_SCAFFOLD: BASE_PROMPT,
        IS_SANDBOX: "1",
      },
      params: {},
      trace: { kind: "none" },
    }),
    "template",
  );
  ok(
    await call("POST", "/harnesses", {
      template: { id: "sbench-claude", version: "1.0.0" },
      id: "sbench-claude",
      version: "1.0.0",
      description: "baseline: told what to do, nothing about how to check it",
      pins: {},
      overrides: { env: { CC_SCAFFOLD: BASE_PROMPT } },
    }),
    "baseline harness",
  );

  const tasks = JSON.parse(readFileSync(`${TASKS}/tasks.json`, "utf8"));
  const byId = new Map(tasks.map((t) => [String(t.id), t]));
  const caseFor = (t) => ({
    id: String(t.id),
    task:
      `Three Excel workbooks are here: 1_${t.id}_input.xlsx, 2_${t.id}_input.xlsx and 3_${t.id}_input.xlsx. ` +
      `Apply the instruction below to EACH of them and save the results here as 1_${t.id}_output.xlsx, ` +
      `2_${t.id}_output.xlsx and 3_${t.id}_output.xlsx.\n\nINSTRUCTION: ${t.instruction}`,
    env: { kind: "repo", source: { files: {} } },
    image: IMAGE,
    graders: [
      {
        id: "reward-file",
        config: {
          cmd: `bash -lc 'mkdir -p /tmp/everdict-reward; for f in *_output.xlsx; do [ -f "$f" ] && /opt/recalc.sh "$f" >/dev/null 2>&1; done; python3 /opt/sbench_digest.py --id ${t.id} --range ${JSON.stringify(t.answer_position)} --sheet ${JSON.stringify(t.answer_sheet ?? "")} --salt ${t.salt} --digests ${t.digests.join(",")} && echo 1.0 > /tmp/everdict-reward/reward.txt || echo 0.0 > /tmp/everdict-reward/reward.txt'`,
          rewardDir: "/tmp/everdict-reward",
          cwd: "work",
        },
      },
    ],
    timeoutSec: 900,
    tags: ["spreadsheetbench"],
  });

  // ── CONCURRENT CAMPAIGNS MAY NOT SHARE A HELD-OUT ROW ────────────────────────────────────────────
  //
  // `heldOutFamilySize` corrects for how many times one held-out set is ASKED, and the platform verifies that
  // along a CHAIN (`continues`): a successor must fit inside its predecessor's pre-registration. It cannot see
  // SIBLINGS, and siblings are what this script creates — so two campaigns opened here with the same held-out
  // case each declare a family covering only themselves, and that row is asked twice as often as either one
  // corrects for. The first wave run with this file did exactly that: case 15380 was held-out in two of three
  // campaigns at family 3, so it answered six rounds under a correction that assumed three.
  //
  // The platform's policy for siblings is an open question (`docs/architecture/evolution-program-gap-map.md`
  // G4.11). The DRIVER's answer is not: a wave lays out its own exams, so it lays them out disjoint.
  {
    const owner = new Map();
    for (const c of PLAN.campaigns)
      for (const id of c.heldOut) {
        const first = owner.get(id);
        if (first !== undefined)
          throw new Error(
            `campaigns '${first}' and '${c.id}' are both held out on case ${id}. Concurrent campaigns spend one held-out row against two families that each count only themselves, so the correction is wrong for both — give each campaign its own held-out cases, or run them as a chain with one family.`,
          );
        owner.set(id, c.id);
      }
  }

  // One dataset per campaign: its own exam, so a campaign's frame names exactly the cases it runs.
  for (const c of PLAN.campaigns) {
    const cases = [...c.targets, ...c.heldOut].map((id) => {
      const t = byId.get(id);
      if (!t) throw new Error(`plan names case ${id}, which the data does not contain`);
      return caseFor(t);
    });
    ok(
      await call("POST", "/datasets", {
        id: `exam-${c.id}`,
        version: "1.0.0",
        description: c.title,
        tags: ["wave"],
        cases,
      }),
      `dataset ${c.id}`,
    );
  }

  const scorecard = async (datasetId, version) => {
    const s = ok(
      await call("POST", "/scorecards", {
        dataset: { id: datasetId, version: "1.0.0" },
        harness: { id: "sbench-claude", version },
        runtime: `self:${runnerId}`,
        trials: TRIALS,
        concurrency: Number(WORKERS),
      }),
      `scorecard ${version}`,
    );
    for (;;) {
      const r = ok(await call("GET", `/scorecards/${s.id}`), "poll");
      if (r.status !== "queued" && r.status !== "running") return { id: s.id, rec: r };
      await sleep(5000);
    }
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
    return [...per.entries()].sort();
  };
  const fmt = (rows) => rows.map(([id, e]) => `${id}:${e.pass}/${e.n}`).join("  ");

  // ── OPEN EVERY CAMPAIGN ───────────────────────────────────────────────────────────────────────────
  line("the tree: one campaign per problem, each frozen before anything runs");
  const live = [];
  for (const c of PLAN.campaigns) {
    const issue = ok(await call("POST", "/issues", { title: c.title, description: c.why }), `issue ${c.id}`);
    const camp = ok(
      await call("POST", "/campaigns", {
        issueId: issue.id,
        frame: {
          subject: { type: "harness", id: "sbench-claude", baselineVersion: "1.0.0" },
          scenarios: [...c.targets.map((id) => ({ id })), ...c.heldOut.map((id) => ({ id, heldOut: true }))],
          targets: c.targets,
          trialsPerCase: TRIALS,
          budget: { maxRounds: c.maxRounds ?? 3 },
          significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 },
          // A self-hosted runner seals no world manifest, so every round reads `execution_world` unverified.
          allowUnverifiedIdentity: true,
        },
      }),
      `campaign ${c.id}`,
    );
    live.push({ ...c, campaignId: camp.id, dataset: `exam-${c.id}`, tried: [], rounds: 0, baseline: undefined });
    show(c.id, `${camp.id} · targets ${c.targets.join(",")} · held-out ${c.heldOut.join(",")}`);
  }

  // ── THE WAVES ─────────────────────────────────────────────────────────────────────────────────────
  let spent = 0;
  for (let wave = 1; spent < MAX_ROUNDS && live.some((c) => c.open !== false); wave++) {
    line(
      `wave ${wave} — ${live.filter((c) => c.open !== false).length} campaign(s) open, ${MAX_ROUNDS - spent} round(s) of budget left`,
    );
    for (const c of live) {
      if (c.open === false || spent >= MAX_ROUNDS) continue;

      // THE PROPOSAL. The next strategy this campaign has not tried, skipping any the WIKI records as inert
      // for the same failure family — which is the whole point of a shared knowledge layer, and the reason
      // the round declares who informed it.
      const inert = new Set(wiki.filter((w) => w.family === c.family && w.outcome === "inert").map((w) => w.strategy));
      const informedBy = [
        ...new Set(wiki.filter((w) => w.family === c.family && w.campaignId !== c.campaignId).map((w) => w.campaignId)),
      ];
      const next = (c.strategies ?? Object.keys(STRATEGIES)).find(
        (s) =>
          !c.tried.includes(s) &&
          !inert.has(s) &&
          (STRATEGIES[s]?.needs ?? []).every((n) => PLAN.environment.provides.includes(n)),
      );
      if (next === undefined) {
        show(c.id, "no strategy left to try — closing this branch");
        c.open = false;
        continue;
      }
      c.tried.push(next);
      const version = `1.${live.indexOf(c) + 1}.${c.tried.length}`;
      ok(
        await call("POST", "/harnesses", {
          template: { id: "sbench-claude", version: "1.0.0" },
          id: "sbench-claude",
          version,
          description: `${c.id}/${next}: ${STRATEGIES[next].summary}`,
          pins: {},
          overrides: { env: { CC_SCAFFOLD: STRATEGIES[next].scaffold } },
        }),
        `candidate ${version}`,
      );

      // The baseline is the FRAME's, so it is run once per campaign and reused: re-running it every round
      // would double the cost and add noise to the thing every round is measured against.
      if (c.baseline === undefined) {
        const b = await scorecard(c.dataset, "1.0.0");
        c.baseline = b.id;
        show(`${c.id} baseline`, fmt(profile(b.rec)));
      }
      const cand = await scorecard(c.dataset, version);
      show(`${c.id} ${next}`, fmt(profile(cand.rec)));

      // THE FINDING IS WRITTEN FROM THE MEASUREMENT, so it is composed here — after the scorecard and before
      // the round. The door requires at least ten characters and is right to: "PENDING" is exactly the shape
      // this field fails as, and the first run of this script was refused for writing one.
      const rows = profile(cand.rec);
      const movedRows = rows.filter(([, e]) => e.pass > 0);
      const tgtRows = rows.filter(([id]) => c.targets.includes(id));
      const learned =
        movedRows.length === 0
          ? `${next} left every case at zero on ${c.family}: the strategy did not reach this failure mode at all, so the next proposal in this family should not spend a round on a variation of it.`
          : `${next} moved ${movedRows.map(([id, e]) => `${id} to ${e.pass}/${e.n}`).join(", ")}; the targets read ${tgtRows.map(([id, e]) => `${id} ${e.pass}/${e.n}`).join(", ")}. A case that moves but does not flip is a strategy that reaches the mechanism and does not settle it.`;

      const logged = await call("POST", `/campaigns/${c.campaignId}/rounds`, {
        hypothesis: `${STRATEGIES[next].summary} — for ${c.family}`,
        learned,
        candidateVersion: version,
        baselineScorecardId: c.baseline,
        candidateScorecardId: cand.id,
        ...(informedBy.length > 0 ? { informedBy } : {}),
      });
      spent += 1;
      if (logged.status >= 300) {
        show(`${c.id} REFUSED`, `${logged.status} ${String(logged.json?.message ?? "").slice(0, 160)}`);
        c.open = false;
        continue;
      }
      const v = logged.json.round?.verdict ?? (logged.json.rounds ?? []).at(-1)?.verdict ?? {};
      const flipped = v.targets?.flipped ?? [];
      const moved = movedRows.map(([id]) => id);
      show(`${c.id} verdict`, {
        comparable: v.comparable,
        significant: `${v.significantImprovements}/${v.significantRegressions}`,
        targets: v.targets,
        heldOut: v.heldOut,
      });

      // THE FINDING. Written from what the round MEASURED, never from what it hoped — and it is what the next
      // proposal in any branch of this family reads.
      wiki.push({
        wave,
        campaignId: c.campaignId,
        family: c.family,
        strategy: next,
        outcome: flipped.length > 0 ? "flipped" : moved.length > 0 ? "moved" : "inert",
        note: learned,
        informedBy,
      });

      const dec = ok(await call("GET", `/campaigns/${c.campaignId}/decision`), "decision");
      show(`${c.id} gate`, dec);
      if (dec.kind !== "continue") {
        const settled = await call("POST", `/campaigns/${c.campaignId}/settle`, {});
        show(
          `${c.id} settle`,
          `${settled.status} ${String(settled.json?.record?.state ?? settled.json?.message ?? "")}`,
        );
        c.open = false;
      }
    }

    // ── THE WIKI, REWRITTEN AFTER EVERY WAVE ────────────────────────────────────────────────────────
    const md = [
      "# Evolution wiki — what the branches have learned",
      "",
      "Written by `scripts/live/evolution-wave.mjs` after each wave. Every row is a finding a round MEASURED.",
      "",
      "⚠️ ADVICE, NEVER EVIDENCE. The adoption gate does not read any of this and must not: a loop may not",
      "write its own report card. What it feeds is the next PROPOSAL, in this branch and in its siblings —",
      "which is why each round records `informedBy`, so a reader can see when two branches stopped being",
      "independent searches.",
      "",
      "| wave | campaign | family | strategy | outcome | what it taught | informed by |",
      "|---|---|---|---|---|---|---|",
      ...wiki.map(
        (w) =>
          `| ${w.wave} | ${w.campaignId} | ${w.family} | ${w.strategy} | ${w.outcome} | ${w.note} | ${w.informedBy.join(", ") || "—"} |`,
      ),
      "",
      "## Strategies ruled inert, by family",
      "",
      ...[...new Set(wiki.map((w) => w.family))].map((f) => {
        const dead = wiki.filter((w) => w.family === f && w.outcome === "inert").map((w) => w.strategy);
        return `- **${f}**: ${dead.length > 0 ? dead.join(", ") : "none yet"} — a later branch skips these rather than paying for them again.`;
      }),
    ].join("\n");
    writeFileSync(WIKI, md);
    show("wiki", `${wiki.length} finding(s) → ${WIKI}`);
  }

  line("the tree, settled");
  for (const c of live) {
    const rec = ok(await call("GET", `/campaigns/${c.campaignId}`), "read");
    const adoption = await call("GET", `/campaigns/${c.campaignId}/adoption`);
    show(c.id, {
      state: rec.state,
      rounds: (rec.rounds ?? []).length,
      tried: c.tried,
      authorized: adoption.json?.operation?.proof?.candidate?.version ?? null,
    });
  }
  show("rounds spent", `${spent} of ${MAX_ROUNDS}`);
  console.log(`\nThe wiki is at ${WIKI}.`);
} finally {
  runner?.kill("SIGTERM");
  cp.kill("SIGTERM");
}
