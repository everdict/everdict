#!/usr/bin/env node
// Agent-configuration evals — does the configuration that steers the agent still carry its lessons?
//
// `pnpm docs-check` and `pnpm convention-harness` ask whether CLAUDE.md, the rules and the skills are still
// SHAPED right: paths resolve, symbols exist, globs match live code, descriptions survive. Neither can ask the
// question that matters after a skill is edited — does the agent still do the work to the same standard? A
// skill that stops triggering, a rule whose wording drifted, a CLAUDE.md line deleted as redundant: each
// leaves every existing gate green, and the only witness is the next session that quietly does it wrong.
//
// ⚠️ THE SESSION UNDER TEST WRITES. `--allowedTools` ADDS to what is permitted; it does not restrict, and a
// session started at this repository root inherits `.claude/settings.json`, which allows `Edit(packages/**)`.
// The suite's first real run created `packages/graders/src/step-budget.ts` and edited two more files while
// answering a question about graders — an eval that mutates the repository it is evaluating contaminates
// every case after it (the very next one read the stray file and mentioned it). So every case runs in a
// THROWAWAY WORKTREE, mutating tools are denied, and the tree is CHECKED afterwards: the deny flag is a
// request until something observes it refusing.
//
// `--drill <id>` removes the sentences a case declares as its lesson and requires that case to go RED. A case
// that stays green without its lesson is not measuring it, and this repository has twice paid for what such a
// certificate is worth. Because the drill edits the worktree and not the repository, a killed run leaves
// nothing behind.
//
// Usage:
//   node evals/run.mjs [--only <id>] [--model <alias>] [--timeout <sec>]
//   node evals/run.mjs --drill <id>        # one case's removal drill, recorded in the history
//   node evals/run.mjs --drill-all         # every case's drill; refuses if any stays green
//   node evals/run.mjs --list
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATHS, CONFIG_PATHSPEC } from "../scripts/hooks/gate-decision.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDir = path.join(root, "evals", "cases");
const resultDir = path.join(root, "evals", ".results");

// The configuration under test. Copied from the working tree into the worktree so a maintainer can run the
// suite against a skill edit BEFORE committing it — which is when the answer is still cheap to change.
// Copied into the worktree so a skill edit can be tested BEFORE it is committed. `evals` is not overlaid —
// the runner reads its cases from the working tree directly — but it is part of what the push gate asks
// about, so it is part of what must be clean before a stamp is written.
const CONFIG = CONFIG_PATHS;
// The history is what a run WRITES, so it cannot be part of what a run attests — see CONFIG_PATHSPEC.
const CLEAN_PATHSPEC = CONFIG_PATHSPEC;

// ⚠️ THE CACHE KEY HAS TO NAME WHAT WAS UNDER TEST, AND THE HEAD SHA DOES NOT.
//
// The overlay above is the whole point of this runner: a maintainer edits a skill and asks whether the agent
// still does the work, BEFORE committing — which is when the answer is still cheap to change. That edit does
// not move HEAD. So a cache keyed on `head + model` answered from a run of the PREVIOUS wording, and the one
// workflow the overlay exists to serve was the one it silently refused to perform: delete the sentence a case
// is about, run `--only <case>`, and get a green off a result produced before the deletion.
//
// The digest is over the overlaid BYTES, which is what the session actually reads. `--fresh` still ignores
// the cache entirely; the drill still never touches it.
//
// ⚠️ AND IT MUST NOT HASH WHAT A RUN WRITES, WHICH THE FIRST VERSION DID. `CONFIG` contains `evals`, and
// `evals/` holds `.results/` — this cache — and `history.jsonl`, which every run appends to. So the key
// churned on every invocation and the cache could never hit: the fix that closed a real hole (an
// uncommitted config edit answered from a stale pass) silently destroyed the resume the cache exists for,
// and the only visible symptom is a suite that costs full price every time, which reads like normal.
//
// The rule is already written down twice in this file: `CONFIG_PATHSPEC` excludes `history.jsonl` because
// "the history is what a run WRITES, so it cannot be part of what a run attests", and the overlay itself
// filters `evals` out at line 196. Same sentence, third place.
const WRITTEN_BY_A_RUN = new Set([path.join("evals", ".results"), path.join("evals", "history.jsonl")]);
const configDigest = (() => {
  const h = createHash("sha256");
  const walk = (rel) => {
    if (WRITTEN_BY_A_RUN.has(rel)) return;
    const abs = path.join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      h.update(`${rel}\u0000<absent>\u0000`); // an overlaid path that is GONE is a different configuration
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) walk(path.join(rel, entry));
      return;
    }
    h.update(`${rel}\u0000`);
    h.update(readFileSync(abs));
    h.update("\u0000");
  };
  for (const item of CONFIG) walk(item);
  return h.digest("hex").slice(0, 16);
})();
// Everything that can change the tree or leave the machine. Deny wins over the repo's own allow list.
const DENIED = "Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch";

// ── options, refused when unrecognised ───────────────────────────────────────────────────────────
// A plausible misspelling accepted in silence turns one case into the whole suite, or a drill into a no-op.
// `scripts/trust/protocol-mutations.mjs` learned that expensively; there is no reason to learn it twice.
const KNOWN = new Set([
  "--only",
  "--drill",
  "--drill-all",
  "--drill-status",
  "--model",
  "--timeout",
  "--list",
  "--fresh",
]);
const argv = process.argv.slice(2);
const opts = { timeout: 120, model: "sonnet" };
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (!KNOWN.has(flag)) {
    console.error(`✖ agent-evals: unknown option "${flag}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  if (flag === "--list" || flag === "--fresh" || flag === "--drill-all" || flag === "--drill-status") {
    opts[flag.slice(2).replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = true;
    continue;
  }
  const value = argv[++i];
  if (value === undefined) {
    console.error(`✖ agent-evals: ${flag} needs a value.`);
    process.exit(1);
  }
  opts[flag.slice(2)] = flag === "--timeout" ? Number(value) : value;
}

// ── the corpus ───────────────────────────────────────────────────────────────────────────────────
if (!existsSync(caseDir)) {
  console.error("✖ agent-evals: evals/cases/ is missing — there is nothing to run, which is not a pass.");
  process.exit(1);
}
const cases = readdirSync(caseDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ ...JSON.parse(readFileSync(path.join(caseDir, f), "utf8")), file: `evals/cases/${f}` }));
if (cases.length === 0) {
  console.error("✖ agent-evals: zero cases. An empty suite reports green over a question it never asked.");
  process.exit(1);
}
for (const c of cases) {
  for (const field of ["id", "why", "subject", "neutralize", "prompt", "expect"]) {
    if (!c[field]) {
      console.error(`✖ agent-evals: ${c.file} has no \`${field}\`.`);
      process.exit(1);
    }
  }
  const bodies = [];
  for (const file of c.subject) {
    if (!existsSync(path.join(root, file))) {
      console.error(
        `✖ agent-evals: ${c.file} declares subject "${file}", which does not exist. A case whose subject is gone tests nothing.`,
      );
      process.exit(1);
    }
    bodies.push(readFileSync(path.join(root, file), "utf8"));
  }
  // Checked HERE, not only inside --drill: a `neutralize` string whose line was reworded still reads as a
  // declaration of what this case measures, and the suite would go on certifying a lesson nobody can remove.
  // Same rule `protocol-mutations` applies to a rung whose target line is gone.
  for (const needle of c.neutralize) {
    // Line-wise, because the DRILL is line-wise: a needle spanning a newline matched the whole-file check and
    // then matched nothing at drill time, so a mis-declared case loaded clean and failed only when someone
    // finally ran the drill. The two must ask the same question.
    if (!bodies.some((body) => body.split("\n").some((line) => line.includes(needle)))) {
      console.error(
        `✖ agent-evals: ${c.file} declares \`neutralize\` ${JSON.stringify(needle)}, which appears in none of ${c.subject.join(", ")}.\n  The lesson it names was reworded or removed — re-point the case at the sentence that carries it now.`,
      );
      process.exit(1);
    }
  }
}

// ── the lesson must not live anywhere the case does not name ─────────────────────────────────────
//
// The check above asks whether a neutralization is PRESENT in some subject. It never asked whether the same
// lesson is ABSENT everywhere else — and on 2026-09-06 a removal drill stayed green because the sentence a
// case removes from CLAUDE.md and rule `ci` had been copied, the day before, into a `lessons/` entry and
// into this suite's own README, neither of which the case named. The session under test can Grep the whole
// tree; it found the copy and answered from it. The drill measured nothing, and nothing said so.
//
// The fingerprint is the case's whole `neutralize` set: a tracked markdown file outside `subject` that carries
// EVERY needle carries the lesson, and either becomes a subject (so the drill removes it there too) or is
// reworded. One needle alone is not a leak — "unsafe" appears in a rule about casts — and the drill itself
// still catches a partial copy. Declared by the case, not inferred from prose.
//
// ⚠️ EVERY TRACKED TEXT FILE, NOT ONLY MARKDOWN. The first version scanned `*.md`, and a lesson lives in the
// CHECK that enforces it as often as in a rule: `ci-local-before-push` and `dont-dodge-the-push-gate` carry
// their whole fingerprint in `scripts/*.mjs` comments, and `madge-exit-code` in `check-import-cycles.mjs`.
// The session under test reads those the same way it reads a rule, so a markdown-only pre-filter left the
// drill certifying nothing there and only `--drill-status` (or a real drill) caught it. Widened to the text
// extensions a lesson can hide in; a `.mjs` a case names as a subject is drilled there too (removing comment
// lines is harmless — the worktree copy is read, never executed).
const TEXT = /\.(md|mjs|cjs|m?ts|tsx|js|json|ya?ml|txt|sh|py)$/;
const trackedText = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .stdout.split("\n")
  .filter(Boolean)
  .filter((file) => TEXT.test(file) && !file.startsWith("evals/cases/"));
const fileLines = new Map();
const linesOf = (file) => {
  if (!fileLines.has(file)) {
    try {
      fileLines.set(file, readFileSync(path.join(root, file), "utf8").split("\n"));
    } catch {
      fileLines.set(file, []);
    }
  }
  return fileLines.get(file);
};
const leaking = [];
for (const c of cases) {
  const named = new Set(c.subject);
  const leaks = trackedText.filter(
    (file) => !named.has(file) && c.neutralize.every((needle) => linesOf(file).some((line) => line.includes(needle))),
  );
  if (leaks.length > 0) leaking.push(`${c.file} → ${leaks.join(", ")}`);
}
if (leaking.length > 0) {
  console.error(
    `✖ agent-evals: ${leaking.length} case(s) measure a lesson that also lives in a file \`subject\` does not name:\n${leaking.map((l) => `    ${l}`).join("\n")}\n  A session can read it there after the drill removes it from the subjects, so the drill would certify nothing.\n  Add the file to \`subject\` (the drill then removes the lesson there too), or reword it so the case's fingerprint is unique.`,
  );
  process.exit(1);
}

if (opts.list) {
  for (const c of cases) console.log(`${c.id.padEnd(32)} ${c.subject.join(", ")}`);
  process.exit(0);
}
if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error(
    "✖ agent-evals: the `claude` CLI is not runnable here, so no case ran.\n  That is a FAILURE, not a skip — a suite reporting green because it never executed is worse than none.\n  Install it (`npm i -g @anthropic-ai/claude-code`) and provide ANTHROPIC_API_KEY.",
  );
  process.exit(1);
}

// ── the throwaway worktree ───────────────────────────────────────────────────────────────────────
const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const wt = path.join(tmpdir(), `everdict-agent-evals-${process.pid}`);
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const porcelain = () =>
  new Set(
    spawnSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" })
      .stdout.split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean),
  );
const teardown = () => {
  git("worktree", "remove", "--force", wt);
  rmSync(wt, { recursive: true, force: true });
};
const setup = () => {
  rmSync(wt, { recursive: true, force: true });
  const add = git("worktree", "add", "--detach", "--quiet", wt, "HEAD");
  if (add.status !== 0) {
    console.error(`✖ agent-evals: could not create the throwaway worktree.\n${add.stderr}`);
    process.exit(1);
  }
  for (const item of CONFIG.filter((i) => i !== "evals"))
    cpSync(path.join(root, item), path.join(wt, item), { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });
}

// ── running one case ─────────────────────────────────────────────────────────────────────────────
const ask = (c) => {
  const args = ["-p", c.prompt, "--output-format", "json", "--model", opts.model, "--disallowedTools", DENIED];
  if (c.allowedTools) args.push("--allowedTools", c.allowedTools);
  const seconds = c.timeout ?? opts.timeout;
  const res = spawnSync("claude", args, {
    cwd: wt,
    encoding: "utf8",
    timeout: seconds * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error?.code === "ETIMEDOUT") return { ok: false, text: "", note: `timed out after ${seconds}s` };
  if (res.status !== 0)
    return {
      ok: false,
      text: res.stdout ?? "",
      note: `claude exited ${res.status}: ${(res.stderr ?? "").slice(0, 400)}`,
    };
  try {
    const doc = JSON.parse(res.stdout);
    return {
      ok: true,
      text: String(doc.result ?? ""),
      cost: doc.total_cost_usd ?? 0,
      turns: doc.num_turns,
      // `--model sonnet` is an ALIAS, and the README used to call it a pin. An alias moves when the provider
      // moves it, with no commit here to trigger on — so the model that actually answered is recorded from
      // the envelope, per case and per run. Provenance at the source (rule `protocol` L3): the run says what
      // ran, instead of the configuration claiming what it asked for.
      models: Object.keys(doc.modelUsage ?? {}).sort(),
    };
  } catch {
    return {
      ok: false,
      text: res.stdout ?? "",
      note: "output was not the JSON envelope --output-format json promises",
    };
  }
};

const judge = (c, text) => {
  const misses = [];
  for (const pattern of c.expect.mustMatch ?? []) {
    if (!new RegExp(pattern, "is").test(text)) misses.push(`must match /${pattern}/ — the answer never names it`);
  }
  for (const pattern of c.expect.mustNotMatch ?? []) {
    if (new RegExp(pattern, "is").test(text))
      misses.push(`must NOT match /${pattern}/ — the recorded failure came back`);
  }
  return misses;
};

// ⚠️ A SUITE THAT CANNOT FINISH IS A SUITE THAT NEVER STAMPS. Twenty cases is eleven or twelve minutes, and an
// interruption at minute ten threw away the nineteen that had already passed — twice, on the same long case.
// A PASSING result is cached under the head, model AND CONFIG DIGEST it was produced for, so a re-run does
// only what is left; a different head, model or overlaid configuration never reuses one, because the
// configuration is exactly what the case is about.
// `--fresh` ignores the cache. Third tool this week to need this; the review caches parts for the same reason.
const cachedPass = (c) => {
  try {
    const prior = JSON.parse(readFileSync(path.join(resultDir, `${c.id}.json`), "utf8"));
    return prior.head === headSha && prior.model === opts.model && prior.config === configDigest && prior.pass === true
      ? prior
      : undefined;
  } catch {
    return undefined;
  }
};

const record = (c, fields, { cache = true } = {}) => {
  if (!cache) return; // a drill's result describes a NEUTRALIZED tree and may never be reused as a pass
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(
    path.join(resultDir, `${c.id}.json`),
    JSON.stringify({ id: c.id, head: headSha, model: opts.model, config: configDigest, ...fields }, null, 2),
  );
};

const runCase = (c, { cache = true } = {}) => {
  // ⚠️ THE DRILL NEVER READS THE CACHE. It calls this with the lesson removed from the worktree, and a cached
  // pass under the same head would be reused — so the drill would report on a run that never happened, against
  // a configuration it never saw. The cache was added an hour before this comment and defeated the one
  // mechanism that makes the suite evidence rather than twenty answers.
  if (cache && !opts.fresh) {
    const prior = cachedPass(c);
    if (prior !== undefined)
      return {
        pass: true,
        ok: true,
        misses: [],
        seconds: prior.seconds,
        cost: 0,
        reused: true,
        models: prior.models ?? [],
      };
  }
  process.stdout.write(`· ${c.id} …\r`);
  const before = porcelain();
  const started = Date.now();
  const answer = ask(c);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  // The deny flag is a request until something observes it refusing. This is that observation.
  const wrote = [...porcelain()].filter((p) => !before.has(p));
  if (wrote.length > 0) {
    record(c, { pass: false, ...answer, seconds }, { cache });
    // `ok: false` — the session mutated the tree, so its answer is not a clean signal about the configuration.
    // A drill treats this as inconclusive rather than as a red, for the same reason it treats an errored call.
    return {
      pass: false,
      ok: false,
      misses: [
        `the session MUTATED the tree under test: ${wrote.join(", ")} — an eval that writes contaminates every case after it`,
      ],
      seconds,
      cost: answer.cost ?? 0,
    };
  }
  if (!answer.ok) {
    record(c, { pass: false, ...answer, seconds }, { cache });
    // `ok: false` — the agent did not produce an answer (a non-zero exit, a timeout, a non-envelope reply).
    // The suite counts this as a case failure, but a DRILL may not read it as a red: "the agent errored" and
    // "the agent answered wrong without its lesson" are different facts, and a rate-limited run that recorded
    // the first as the second would manufacture a drill certificate the audit exists to refuse.
    return { pass: false, ok: false, misses: [answer.note], seconds, cost: 0 };
  }
  const misses = judge(c, answer.text);
  record(c, { pass: misses.length === 0, misses, ...answer, seconds }, { cache });
  return { pass: misses.length === 0, ok: true, misses, seconds, cost: answer.cost ?? 0, models: answer.models ?? [] };
};

// ── removal drill ────────────────────────────────────────────────────────────────────────────────
//
// ⚠️ A DRILL RESULT IS A LEDGER LINE. Until 2026-09-06 a drill was run once, when its case was written, and
// its verdict lived in a terminal that closed. Nothing recorded that it had ever passed, nothing re-ran it,
// and one went stale the day after its case landed — the lesson was copied into a second file and the case
// kept passing without it. So every drill appends `{drill: <id>, red: true|false}` to `evals/history.jsonl`
// (the band reader skips those lines), and `--drill-all` re-runs every case's drill and refuses if any stays
// green. The 90-day rule the audit applies to a certificate applies here: a drill nobody has re-run is a
// claim, and the ledger says when it was last a fact.
// A drill certifies the SUBJECTS AS THEY WERE. The line carries a digest of their bytes, so `--drill-status`
// can say whether a red drill still describes the files a session would read today, without replaying it.
const subjectsDigest = (c) => {
  const h = createHash("sha256");
  for (const file of c.subject) {
    h.update(`${file}\u0000`);
    h.update(readFileSync(path.join(root, file)));
    h.update("\u0000");
  }
  return h.digest("hex").slice(0, 16);
};
const recordDrill = (c, red, seconds) => {
  appendFileSync(
    path.join(root, "evals", "history.jsonl"),
    `${JSON.stringify({
      at: new Date().toISOString(),
      model: opts.model,
      drill: c.id,
      red,
      seconds,
      subjects: subjectsDigest(c),
    })}\n`,
  );
};
/** Per case: the latest drill line, and whether its subjects are still the ones it certified. */
const drillStatus = () => {
  let rows = [];
  try {
    rows = readFileSync(path.join(root, "evals", "history.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => typeof r.drill === "string");
  } catch {
    rows = [];
  }
  return cases.map((c) => {
    const last = rows.filter((r) => r.drill === c.id).at(-1);
    if (last === undefined) return { id: c.id, state: "never" };
    if (last.red !== true) return { id: c.id, state: "green", at: last.at };
    return { id: c.id, state: last.subjects === subjectsDigest(c) ? "red" : "drifted", at: last.at };
  });
};
if (opts.drillStatus) {
  const WORD = {
    never: "NEVER drilled — the case has never been shown to measure its lesson",
    green: "GREEN under its drill — the case passes without its lesson; it certifies nothing",
    drifted: "red, but a subject changed since — re-drill to re-certify",
    red: "red — certified",
  };
  for (const row of drillStatus()) {
    console.log(`${row.id.padEnd(32)} ${WORD[row.state]}${row.at ? ` (${row.at.slice(0, 10)})` : ""}`);
  }
  process.exit(0);
}
if (opts.drill || opts.drillAll) {
  const targets = opts.drillAll ? cases : cases.filter((x) => x.id === opts.drill);
  if (targets.length === 0) {
    console.error(`✖ agent-evals: no case "${opts.drill}". \`--list\` shows them.`);
    process.exit(1);
  }
  // ⚠️ `process.exit()` inside a `try` does NOT run its `finally`. The first version of this drill called it
  // from inside and leaked a throwaway worktree on every run — the same shape as a `finally` a kill never
  // reaches, which this repository already records for `protocol-mutations`. The drill computes a code and
  // the process exits AFTER teardown, never during.
  const drill = (c) => {
    console.log(
      `▶ removal drill · ${c.id}\n  removing ${c.neutralize.length} lesson line(s) from ${c.subject.join(", ")}\n`,
    );
    // Delete the LINES that carry the lesson, not the files that hold them. Blanking a whole CLAUDE.md proves
    // only that an empty CLAUDE.md steers nothing; removing the sentence asks whether THAT sentence steers.
    const removed = new Map(c.neutralize.map((needle) => [needle, 0]));
    for (const file of c.subject) {
      const target = path.join(wt, file);
      const kept = [];
      for (const line of readFileSync(target, "utf8").split("\n")) {
        // Every needle this line satisfies, not just the first: a heading carrying two of them credited one
        // and reported the other as matching nothing, which reads exactly like a mis-declared case.
        const hits = c.neutralize.filter((needle) => line.includes(needle));
        if (hits.length === 0) kept.push(line);
        else for (const hit of hits) removed.set(hit, (removed.get(hit) ?? 0) + 1);
      }
      writeFileSync(target, kept.join("\n"));
    }
    const unmatched = [...removed].filter(([, n]) => n === 0).map(([needle]) => needle);
    if (unmatched.length > 0) {
      console.error(
        `✖ agent-evals: these \`neutralize\` strings matched no line in the worktree copy:\n${unmatched.map((u) => `    ${JSON.stringify(u)}`).join("\n")}\n  A neutralization that removes nothing runs the case against the configuration intact and calls the green a drill.`,
      );
      return 1;
    }
    const out = runCase(c, { cache: false });
    // ⚠️ AN ERRORED AGENT CALL IS NOT A RED. `runCase` returns `ok: false` when the agent did not answer — a
    // non-zero exit, a timeout, a mutated tree. A rate-limited `--drill-all` produced exactly this: ten calls
    // in a row exited 1 in two seconds each, and the drill was reading `!pass` as red and recording a
    // certificate for a run that never happened. Inconclusive is a third value: it records nothing and returns
    // code 2, and `--drill-all` fails on it rather than calling a rate limit a green.
    if (!out.ok) {
      console.error(
        `\n? DRILL INCONCLUSIVE — "${c.id}" — the agent did not answer (${out.misses.join("; ") || "no reason"}). Nothing recorded; re-run when the agent is reachable.`,
      );
      return 2;
    }
    recordDrill(c, !out.pass, Number(out.seconds));
    if (out.pass) {
      console.error(
        `\n✖ DRILL FAILED — "${c.id}" still passes with its lesson removed (${out.seconds}s).\n  The case is not measuring what it claims to. Either the lesson is carried somewhere \`subject\` does not name,\n  or the assertions are satisfied by something other than the configuration.`,
      );
      return 1;
    }
    console.log(`\n✓ DRILL PASSED — "${c.id}" went red without its lesson (${out.seconds}s).`);
    for (const m of out.misses) console.log(`  · ${m}`);
    return 0;
  };
  // One throwaway worktree PER drill: a neutralization is destructive, and the next case must start from
  // the configuration intact.
  const stale = [];
  const inconclusive = [];
  for (const c of targets) {
    setup();
    let code = 1;
    try {
      code = drill(c);
    } finally {
      teardown();
    }
    if (code === 1) stale.push(c.id);
    else if (code === 2) inconclusive.push(c.id);
  }
  if (opts.drillAll) {
    const red = targets.length - stale.length - inconclusive.length;
    console.log(
      `\n${red}/${targets.length} drills went red` +
        `${stale.length > 0 ? ` · STALE (green without their lesson): ${stale.join(", ")}` : ""}` +
        `${inconclusive.length > 0 ? ` · INCONCLUSIVE (agent unreachable): ${inconclusive.join(", ")}` : ""}`,
    );
    if (inconclusive.length > 0) {
      console.error(
        `\n✖ ${inconclusive.length} drill(s) could not run — the agent did not answer, most likely a rate limit. A drill-all with an inconclusive drill is not a pass; re-run when the agent is reachable.`,
      );
    }
  }
  // Stale (a case that does not measure its lesson) and inconclusive (the agent never answered) are both
  // failures, and for different reasons — the first is a broken case, the second a run that did not happen.
  process.exit(stale.length === 0 && inconclusive.length === 0 ? 0 : 1);
}

// ── the suite ────────────────────────────────────────────────────────────────────────────────────
const selected = opts.only ? cases.filter((c) => c.id === opts.only) : cases;
if (selected.length === 0) {
  console.error(`✖ agent-evals: --only "${opts.only}" matched no case. \`--list\` shows them.`);
  process.exit(1);
}
setup();
let failed = 0;
let spend = 0;
const outcomes = [];
try {
  console.log(`▶ agent-evals · ${selected.length} case(s) · model ${opts.model} · worktree ${path.basename(wt)}\n`);
  for (const c of selected) {
    const out = runCase(c);
    spend += out.cost;
    // ⚠️ `reused` RIDES INTO THE HISTORY. `evals/history.jsonl` is the declared input to a control band, and
    // a run built from cache hits used to look identical there to one where every case was freshly executed
    // — so "the configuration was re-verified today" and "verified once and reused nineteen times" were the
    // same record. The suite-wide `cost` hinted at it and a hint is not a field. It matters more now that
    // the cache key is correct enough to actually hit.
    outcomes.push({
      id: c.id,
      pass: out.pass,
      seconds: Number(out.seconds),
      reused: Boolean(out.reused),
      models: out.models ?? [],
    });
    if (out.pass) {
      console.log(`✓ ${c.id.padEnd(32)} ${out.seconds}s${out.reused ? " — reused" : ""}`);
      continue;
    }
    failed++;
    console.log(`✖ ${c.id.padEnd(32)} ${out.seconds}s`);
    for (const m of out.misses) console.log(`    ${m}`);
    console.log(`    why this case exists: ${c.why}`);
    console.log(`    subject: ${c.subject.join(", ")} · transcript: evals/.results/${c.id}.json`);
  }
} finally {
  teardown();
}
console.log(`\n${selected.length - failed}/${selected.length} passed · $${spend.toFixed(4)}`);

// ⚠️ AFTER the history, never before. A failing run used to exit here, so `evals/history.jsonl` only ever
// received SUCCESSES — and `eval-pass-rate`, the band whose entire job is to notice the suite getting worse,
// watched a series that could not contain a regression. The one indicator here that is about behaviour was
// structurally incapable of moving.
// ── the history ──────────────────────────────────────────────────────────────────────────────────
//
// `.results/` is overwritten every run, so the eval pass rate — the one leading indicator this harness
// produces — had no history at all. That closes a door: a control band needs a rolling baseline, and a
// baseline cannot be collected retroactively. Every unrecorded run is a run that can never be part of one.
// A `--only` run is recorded as `partial` rather than dropped, so a future band can filter it out instead of
// averaging one case into a suite-wide rate.
appendFileSync(
  path.join(root, "evals", "history.jsonl"),
  `${JSON.stringify({
    at: new Date().toISOString(),
    model: opts.model,
    // The alias asked for is above; the model IDs that actually answered are here, so an alias that moved
    // under the suite is visible in the ledger rather than assumed away by the word "pinned".
    models: [...new Set(outcomes.flatMap((o) => o.models))].sort(),
    partial: Boolean(opts.only),
    passed: selected.length - failed,
    of: selected.length,
    // How much of that pass was EXECUTED. A band over a run of twenty reused results is a band over nothing.
    executed: outcomes.filter((o) => !o.reused).length,
    cost: Number(spend.toFixed(4)),
    cases: outcomes,
  })}\n`,
);

// ── the push stamp ───────────────────────────────────────────────────────────────────────────────
//
// This suite is not in `ci:local` and not in CI (a GitHub runner has no login, and the secret that would give
// it one is a cost of the delivery choice, not of the suite). What keeps it from being advisory is
// `scripts/hooks/pre-push-gate.mjs`: a push that CHANGES the configuration under test must carry a green run.
//
// A partial run cannot stamp — `--only` answers about one case and the gate asks about the configuration.
// And a run over DIRTY configuration says nothing about HEAD: the suite reads its cases from the working tree
// and overlays the working tree's CLAUDE.md/.claude into the worktree, exactly so an edit can be tested before
// it is committed, which is the same reason the stamp cannot then attest the commit.
// ⚠️ THE DRILL STATE IS REPORTED, NOT COUPLED TO THE STAMP — yet. A case that has never gone red without its
// lesson certifies nothing, and the honest gate would refuse the stamp until every case holds a red drill.
// It does not, deliberately: that gate needs one clean `--drill-all` to land with it (this repository forbids
// a gate that ships before its fix, skill `code-review`), and a clean drill-all is twenty real agent calls
// that a rate limit can turn into false reds — which is exactly the bug the `ok`/inconclusive split above was
// written to stop. So the coupling waits on a green drill-all, tracked in
// `intent/2026-09-06-what-the-second-audit-found/`. Until then `--drill-status` reports never / green /
// drifted / red, and the person reads it. What DID land is cheaper and needs no agent: the exclusivity refusal
// at load, which caught the actual audit bug.
const notCertified = drillStatus().filter((r) => r.state !== "red");
if (notCertified.length > 0) {
  console.log(
    `\n· drill status: ${notCertified.length} case(s) are not certified red — ${notCertified
      .map((r) => `${r.id} (${r.state})`)
      .join(
        ", ",
      )}. \`--drill-status\` explains each; \`--drill-all\` re-certifies. Advisory, not gating (see the code comment).`,
  );
}
if (!opts.only && failed === 0) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain", "--", ...CLEAN_PATHSPEC], { cwd: root, encoding: "utf8" })
    .stdout.split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  if (dirty.length > 0) {
    console.log(
      `\n· no push stamp: ${CONFIG.join(", ")} differ from HEAD (${dirty.slice(0, 4).join(", ")}${dirty.length > 4 ? ", …" : ""}).`,
    );
    console.log("  This run tested the working tree; the stamp attests a COMMIT. Commit, then re-run.");
  } else if (head !== "") {
    writeFileSync(path.join(root, ".git", "everdict-evals-ok"), `${head}\n`);
    console.log(
      `\n· push stamp written for ${head.slice(0, 9)} — the gate will accept a configuration change on this HEAD.`,
    );
  }
}

if (failed > 0) {
  console.error("\n✖ agent-evals RED — the configuration stopped carrying a lesson it is supposed to carry.");
  process.exit(1);
}
