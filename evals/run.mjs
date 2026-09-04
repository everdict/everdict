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
//   node evals/run.mjs --drill <id>
//   node evals/run.mjs --list
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDir = path.join(root, "evals", "cases");
const resultDir = path.join(root, "evals", ".results");

// The configuration under test. Copied from the working tree into the worktree so a maintainer can run the
// suite against a skill edit BEFORE committing it — which is when the answer is still cheap to change.
const CONFIG = ["CLAUDE.md", ".claude"];
// Everything that can change the tree or leave the machine. Deny wins over the repo's own allow list.
const DENIED = "Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch";

// ── options, refused when unrecognised ───────────────────────────────────────────────────────────
// A plausible misspelling accepted in silence turns one case into the whole suite, or a drill into a no-op.
// `scripts/trust/protocol-mutations.mjs` learned that expensively; there is no reason to learn it twice.
const KNOWN = new Set(["--only", "--drill", "--model", "--timeout", "--list"]);
const argv = process.argv.slice(2);
const opts = { timeout: 120, model: "sonnet" };
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (!KNOWN.has(flag)) {
    console.error(`✖ agent-evals: unknown option "${flag}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  if (flag === "--list") {
    opts.list = true;
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
  for (const item of CONFIG) cpSync(path.join(root, item), path.join(wt, item), { recursive: true, force: true });
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
    return { ok: true, text: String(doc.result ?? ""), cost: doc.total_cost_usd ?? 0, turns: doc.num_turns };
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

const runCase = (c) => {
  process.stdout.write(`· ${c.id} …\r`);
  const before = porcelain();
  const started = Date.now();
  const answer = ask(c);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(path.join(resultDir, `${c.id}.json`), JSON.stringify({ id: c.id, ...answer, seconds }, null, 2));
  // The deny flag is a request until something observes it refusing. This is that observation.
  const wrote = [...porcelain()].filter((p) => !before.has(p));
  if (wrote.length > 0) {
    return {
      pass: false,
      misses: [
        `the session MUTATED the tree under test: ${wrote.join(", ")} — an eval that writes contaminates every case after it`,
      ],
      seconds,
      cost: answer.cost ?? 0,
    };
  }
  if (!answer.ok) return { pass: false, misses: [answer.note], seconds, cost: 0 };
  const misses = judge(c, answer.text);
  return { pass: misses.length === 0, misses, seconds, cost: answer.cost ?? 0 };
};

// ── removal drill ────────────────────────────────────────────────────────────────────────────────
if (opts.drill) {
  const c = cases.find((x) => x.id === opts.drill);
  if (!c) {
    console.error(`✖ agent-evals: no case "${opts.drill}". \`--list\` shows them.`);
    process.exit(1);
  }
  // ⚠️ `process.exit()` inside a `try` does NOT run its `finally`. The first version of this drill called it
  // from inside and leaked a throwaway worktree on every run — the same shape as a `finally` a kill never
  // reaches, which this repository already records for `protocol-mutations`. The drill computes a code and
  // the process exits AFTER teardown, never during.
  const drill = () => {
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
    const out = runCase(c);
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
  setup();
  let code = 1;
  try {
    code = drill();
  } finally {
    teardown();
  }
  process.exit(code);
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
try {
  console.log(`▶ agent-evals · ${selected.length} case(s) · model ${opts.model} · worktree ${path.basename(wt)}\n`);
  for (const c of selected) {
    const out = runCase(c);
    spend += out.cost;
    if (out.pass) {
      console.log(`✓ ${c.id.padEnd(32)} ${out.seconds}s`);
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
if (failed > 0) {
  console.error("\n✖ agent-evals RED — the configuration stopped carrying a lesson it is supposed to carry.");
  process.exit(1);
}
