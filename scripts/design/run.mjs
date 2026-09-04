#!/usr/bin/env node
// watches: nothing — reads an intent and writes a spec; it names no live source symbol.
//
// `pnpm design` — the requirements-and-design pass the article puts between Plan and Build.
//
// Ten change directories, nine plans, ZERO specs. The stage was never skipped on purpose; nothing asked for
// it, and an accepted `intent.md` triggered nothing. That is the shape the whole audit was about, one level
// in: not a missing capability, a missing trigger.
//
// `--next` takes the oldest accepted intent without a spec, so running this needs no decision about which —
// the same rotation `pnpm scan --next` uses, applied to a stage rather than to a scope.
//
// ⚠️ IT WRITES INTO THE WORKING TREE AND COMMITS NOTHING. A machine may propose; the spec meets a person
// before it meets a plan. A bad spec that a plan is then written against is worse than no spec at all.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = path.join(root, "intent");
const DENIED = "Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch";

const KNOWN = new Set(["--next", "--change", "--model", "--timeout", "--list"]);
const argv = process.argv.slice(2);
const opts = { model: "sonnet", timeout: 900 };
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) {
    console.error(`✖ design: unknown option "${argv[i]}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  if (argv[i] === "--next" || argv[i] === "--list") {
    opts[argv[i].slice(2)] = true;
    continue;
  }
  const value = argv[++i];
  if (value === undefined) {
    console.error(`✖ design: ${argv[i - 1]} needs a value.`);
    process.exit(1);
  }
  opts[argv[i - 1].slice(2)] = argv[i - 1] === "--timeout" ? Number(value) : value;
}
if (opts.next && opts.change !== undefined) {
  console.error("✖ design: --next and --change contradict each other. Pass one.");
  process.exit(1);
}

const statusOf = (body) => /^Status:\s*([a-z]+)/m.exec(body)?.[1] ?? /Status:\s*([a-z]+)/.exec(body)?.[1];
const changes = readdirSync(home)
  .filter((n) => statSync(path.join(home, n)).isDirectory())
  .sort();

/** Accepted, and no spec yet. `shipped` is past this stage; `draft` has not been taken up; `rejected` is over. */
const waiting = changes.filter((n) => {
  const intentFile = path.join(home, n, "intent.md");
  if (!existsSync(intentFile) || existsSync(path.join(home, n, "spec.md"))) return false;
  return statusOf(readFileSync(intentFile, "utf8")) === "accepted";
});

if (opts.list) {
  if (waiting.length === 0) console.log("· no accepted intent is waiting for a design pass.");
  for (const n of waiting) console.log(n);
  process.exit(0);
}

let change = opts.change;
if (opts.next) {
  if (waiting.length === 0) {
    console.log("· nothing to design: no accepted intent is without a spec.");
    process.exit(0);
  }
  change = waiting[0];
  console.log(`· --next picked "${change}": oldest accepted intent with no spec.`);
}
if (change === undefined) {
  console.error(`✖ design: name a change directory, or use --next / --list. Waiting: ${waiting.join(" ") || "(none)"}`);
  process.exit(1);
}
const dir = path.join(home, change);
const intentFile = path.join(dir, "intent.md");
if (!existsSync(intentFile)) {
  console.error(`✖ design: intent/${change}/intent.md does not exist.`);
  process.exit(1);
}
const specFile = path.join(dir, "spec.md");
if (existsSync(specFile)) {
  console.error(
    `✖ design: intent/${change}/spec.md already exists. Delete it deliberately, or design another change — overwriting a spec somebody reviewed is not a thing this should do quietly.`,
  );
  process.exit(1);
}

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error(
    "✖ design: the `claude` CLI is not runnable here, so no design pass ran. That is a FAILURE, not a skip.",
  );
  process.exit(1);
}

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const wt = path.join(tmpdir(), `everdict-design-${process.pid}`);
const teardown = () => {
  git("worktree", "remove", "--force", wt);
  rmSync(wt, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });
}
rmSync(wt, { recursive: true, force: true });
if (git("worktree", "add", "--detach", "--quiet", wt, "HEAD").status !== 0) {
  console.error("✖ design: could not create the throwaway worktree.");
  process.exit(1);
}

// The spec cites the commit that introduced its intent, for the reason `plan.md` does: a spec written after
// the work reads exactly like one written before it, and only the commit graph can tell. `pnpm intent-chain`
// refuses a spec whose `From:` names something else, or whose own commit does not descend from it.
const intentSha = git("log", "--diff-filter=A", "--format=%H", "--", path.relative(root, intentFile))
  .stdout.split("\n")
  .filter(Boolean)
  .at(-1);
if (intentSha === undefined) {
  console.error(
    `✖ design: intent/${change}/intent.md is not committed yet, so a spec cannot cite the commit that carries the request.`,
  );
  process.exit(1);
}

const prompt = [
  "Produce a requirements and design spec for the intent below, for THIS repository.",
  "",
  "Read first, and apply as constraints: CLAUDE.md, the rules under .claude/rules/ whose paths this change",
  "would touch, and the skills under .claude/skills/ for the areas involved. Those are the organisation's",
  "policies; a spec that a rule would refuse is a spec that wastes a plan.",
  "",
  "Write the spec so an engineer can plan against it. Structure:",
  "  ## Requirements — what must be true, numbered, each one checkable",
  "  ## Design — the shape: which packages, which contracts, what crosses which boundary",
  "  ## Areas of concern — FLAG anything where two policies conflict, where a constraint in the intent cannot",
  "    be met, or where you had to guess. This section is the point of the pass; an empty one is suspicious.",
  "  ## Open questions carried forward — from the intent, answered or restated",
  "",
  "Answer with the markdown of the spec and nothing else. No preamble, no code fences around the whole thing.",
  "",
  "── intent.md ──",
  readFileSync(intentFile, "utf8"),
].join("\n");

let envelope;
try {
  console.log(`▶ design · ${change} · model ${opts.model}\n`);
  const res = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      opts.model,
      "--disallowedTools",
      DENIED,
      "--allowedTools",
      "Read,Grep,Glob",
    ],
    { cwd: wt, encoding: "utf8", timeout: opts.timeout * 1000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error?.code === "ETIMEDOUT") {
    console.error(`✖ design: timed out after ${opts.timeout}s — nothing written.`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`✖ design: claude exited ${res.status}. ${(res.stderr ?? "").slice(0, 400)}`);
    process.exit(1);
  }
  envelope = JSON.parse(res.stdout);
} finally {
  teardown();
}

const body = String(envelope?.result ?? "").trim();
if (body.length < 200 || !body.includes("## Requirements")) {
  console.error(
    "✖ design: the answer is not a spec — no `## Requirements` section, or too short to be one. Nothing written.\n",
  );
  console.error(body.slice(0, 800));
  process.exit(1);
}

writeFileSync(
  specFile,
  `From: intent.md @ ${intentSha}

<!-- Written by \`pnpm design\` from intent.md, model ${opts.model}, ${new Date().toISOString()}.
     A machine proposed this. It is in the working tree and committed by nobody; read it before a plan is
     written against it, and edit it freely — the intent chain applies to this file exactly as to a person's. -->

${body}\n`,
);
console.log(
  `\n· wrote ${path.relative(root, specFile)} — UNCOMMITTED, on purpose. $${(envelope.total_cost_usd ?? 0).toFixed(4)}`,
);
console.log('· read the "Areas of concern" section first; it is the part of the pass a person is for.');
