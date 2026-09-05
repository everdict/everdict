#!/usr/bin/env node
// watches: nothing — reads a diff and a policy file; it names no live symbol of its own.
//
// `pnpm review` — the review pass every push carrying product code gets, applied from `REVIEW.md`.
//
// CLAUDE.md opens with "Review-first … No exceptions", and skill `code-review` records that it has failed
// TWICE and been paid for twice. What fired it was a person remembering to ask. There are no pull requests
// here — 2,710 commits in ninety days carried two merge commits — so there was no moment a review attached
// to and no record that one happened.
//
// ⚠️ IT STAMPS ON COMPLETION, NEVER ON CLEANLINESS. Findings rank and inform; the person decides. The gate
// asks whether the question was PUT, which is the half that was missing. A reviewer that blocks on its own
// findings is neither the article's control nor this repository's, and it would be routed around within a
// week.
//
// Read-only, in a throwaway worktree, for the reason the eval suite is: `--allowedTools` ADDS to what is
// permitted rather than restricting it, and a session started at this root inherits `.claude/settings.json`.
// An agent that reviews a tree it can edit has already stopped being a reviewer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DENIED = "Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch";

const KNOWN = new Set(["--range", "--model", "--timeout"]);
const argv = process.argv.slice(2);
const opts = { model: "sonnet", timeout: 900 };
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) {
    console.error(`✖ review: unknown option "${argv[i]}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  const value = argv[++i];
  if (value === undefined) {
    console.error(`✖ review: ${argv[i - 1]} needs a value.`);
    process.exit(1);
  }
  opts[argv[i - 1].slice(2)] = argv[i - 1] === "--timeout" ? Number(value) : value;
}

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const head = git("rev-parse", "HEAD").stdout.trim();

// The range is what a push would carry, so the review sees exactly what the gate is about to let out.
const remote = git("remote").stdout.split("\n").filter(Boolean)[0];
const base = `${remote}/main`;
const haveBase = remote !== undefined && git("rev-parse", "--verify", "--quiet", base).status === 0;
const range = opts.range ?? (haveBase ? `${base}..HEAD` : "HEAD~1..HEAD");

const files = git("diff", "--name-only", range).stdout.split("\n").filter(Boolean);
if (files.length === 0) {
  console.error(`✖ review: ${range} carries no changes. A review over an empty range would stamp for nothing.`);
  process.exit(1);
}
// ⚠️ ONE TRUNCATED BLOB WOULD BE A FALSE CERTIFICATE. The first draft took the whole diff, cut it at 400 KB
// and stamped as though the range had been reviewed; this branch's range is 1.8 MB over 541 files, so that
// stamp would have covered about a fifth of what it claimed. The diff is grouped per file into chunks that
// each fit, every chunk is reviewed, and a range too large to review in a bounded number of chunks is
// REFUSED — a 541-file push is the problem, not the reviewer.
const MAX_CHUNK = 320_000;
const MAX_CHUNKS = 8;
const chunks = [];
const truncatedFiles = [];
let current = { files: [], diff: "" };
for (const file of files) {
  const fileDiff = git("diff", "--unified=3", range, "--", file).stdout;
  if (fileDiff.length === 0) continue;
  // A single file bigger than a chunk gets its own, truncated, and the truncation is REPORTED rather than
  // absorbed: generated output and lockfiles are the usual cause and they belong in REVIEW.md's skip list.
  if (current.diff.length > 0 && current.diff.length + fileDiff.length > MAX_CHUNK) {
    chunks.push(current);
    current = { files: [], diff: "" };
  }
  // ⚠️ Reported, not absorbed. The comment above claimed this and the code did it silently: a single file
  // bigger than a chunk was cut and the stamp still said the range was reviewed — the same false certificate
  // this file's header says it eliminated, reproduced one level down, per file.
  if (fileDiff.length > MAX_CHUNK) truncatedFiles.push(`${file} (${Math.round(fileDiff.length / 1000)}KB)`);
  current.files.push(file);
  current.diff += fileDiff.slice(0, MAX_CHUNK);
}
if (current.files.length > 0) chunks.push(current);
if (chunks.length === 0) {
  console.error(`✖ review: ${range} produced an empty diff.`);
  process.exit(1);
}
if (truncatedFiles.length > 0) {
  console.error(
    `✖ review: ${truncatedFiles.length} file(s) have a diff larger than one chunk and would be reviewed only in part:\n${truncatedFiles.map((f) => `    ${f}`).join("\n")}\n  A stamp over a truncated file is the false certificate this runner exists to refuse. Skip them in REVIEW.md's "do not report" list, or split the change.`,
  );
  process.exit(1);
}
if (chunks.length > MAX_CHUNKS) {
  console.error(
    `✖ review: ${range} needs ${chunks.length} chunks (limit ${MAX_CHUNKS}) — ${files.length} files. This push is too large to review honestly in one pass.\n  Push smaller ranges, or review slices with \`--range <a>..<b>\` (which deliberately does not stamp).`,
  );
  process.exit(1);
}

const policyPath = path.join(root, "REVIEW.md");
if (!existsSync(policyPath)) {
  console.error(
    "✖ review: REVIEW.md is missing — there is no policy to apply, and an unpolicied review is the state this replaces.",
  );
  process.exit(1);
}

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error(
    "✖ review: the `claude` CLI is not runnable here, so no review ran.\n  That is a FAILURE, not a skip — a stamp written without a review is the thing this gate exists to refuse.",
  );
  process.exit(1);
}

// ── the throwaway worktree ───────────────────────────────────────────────────────────────────────
const wt = path.join(tmpdir(), `everdict-review-${process.pid}`);
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
  console.error("✖ review: could not create the throwaway worktree.");
  process.exit(1);
}

const buildPrompt = (chunk, index) =>
  [
    "You are reviewing a change that is about to be pushed. Apply the repository's review policy, which is in",
    "REVIEW.md at the root of this worktree — read it first, and run the passes it names in the order it names",
    "them. The rules under .claude/rules/ and the skills under .claude/skills/ are the policies the Compliance",
    "pass checks against; read the ones the changed paths touch.",
    "",
    `The change is ${range}. This is part ${index + 1} of ${chunks.length}, covering ${chunk.files.length} file(s).`,
    "Review only what this part contains; another part covers the rest.",
    "",
    "Answer with a JSON object and nothing else:",
    '{"findings":[{"pass":"authorship|leaned-on|bugs|compliance","severity":"important|nit","file":"...",',
    '"line":123,"summary":"one sentence","failure":"inputs or state -> wrong output"}],"nitsOmitted":0,',
    '"summary":"two sentences: what this part does, and the single thing most worth a person\'s attention"}',
    "",
    "```diff",
    chunk.diff,
    "```",
  ].join("\n");

const findings = [];
const summaries = [];
let nitsOmitted = 0;
let spend = 0;
// ⚠️ NOTHING EXITS INSIDE THIS TRY. `process.exit()` skips the `finally` that removes the throwaway worktree —
// the same defect `evals/run.mjs`'s drill had, and the one that leaked a worktree here when a killed run took
// the child with it. Failures set `failure` and break; the exit happens after teardown.
let failure;
try {
  console.log(`▶ review · ${range} · ${files.length} file(s) in ${chunks.length} part(s) · model ${opts.model}\n`);
  for (const [index, chunk] of chunks.entries()) {
    process.stdout.write(`· part ${index + 1}/${chunks.length} (${chunk.files.length} files) …\r`);
    // ⚠️ THE PROMPT GOES ON STDIN, NOT IN ARGV. Passing it as a positional argument worked for every small
    // range and died on the first real one: Linux caps a SINGLE argument at MAX_ARG_STRLEN (128 KiB) whatever
    // ARG_MAX says, and a 320 KiB chunk is over it. `spawnSync` reported `exited null` — a signal, with no
    // message — so the failure looked like a crash rather than a limit. This runner had never been exercised
    // on a range big enough to chunk, which is the only size it exists for.
    const res = spawnSync(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--model",
        opts.model,
        "--disallowedTools",
        DENIED,
        "--allowedTools",
        "Read,Grep,Glob",
      ],
      {
        cwd: wt,
        encoding: "utf8",
        input: buildPrompt(chunk, index),
        timeout: opts.timeout * 1000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (res.error?.code === "ETIMEDOUT") {
      failure = `part ${index + 1} timed out after ${opts.timeout}s — no stamp.`;
      break;
    }
    if (res.status !== 0) {
      const how = res.signal ? `was killed by ${res.signal}` : `exited ${res.status}`;
      failure = `part ${index + 1}: claude ${how}. ${(res.stderr ?? "").slice(0, 400)}`;
      break;
    }
    const envelope = JSON.parse(res.stdout);
    spend += envelope.total_cost_usd ?? 0;
    const text = String(envelope.result ?? "");
    const json = /\{[\s\S]*\}/.exec(text);
    let part;
    try {
      part = JSON.parse(json?.[0] ?? "");
    } catch {
      failure = `part ${index + 1} did not answer with the findings envelope, so there is nothing to record.\n${text.slice(0, 800)}`;
      break;
    }
    for (const f of part.findings ?? []) findings.push(f);
    nitsOmitted += Number(part.nitsOmitted ?? 0);
    if (part.summary) summaries.push(part.summary);
  }
} finally {
  teardown();
}
if (failure !== undefined) {
  console.error(`\n✖ review: ${failure}`);
  process.exit(1);
}

const report = { findings, nitsOmitted, summary: summaries.join(" ") };
const rank = (f) => (f.severity === "important" ? 0 : 1);
findings.sort((a, b) => rank(a) - rank(b));

mkdirSync(path.join(root, ".git"), { recursive: true });
const reportPath = path.join(root, ".git", `everdict-review-${head.slice(0, 12)}.json`);
writeFileSync(
  reportPath,
  JSON.stringify({ at: new Date().toISOString(), head, range, files, parts: chunks.length, ...report }, null, 2),
);

const important = findings.filter((f) => f.severity === "important");
for (const f of findings) {
  const mark = f.severity === "important" ? "‼" : "·";
  console.log(`${mark} [${f.pass}] ${f.file}${f.line ? `:${f.line}` : ""}\n    ${f.summary}\n    ${f.failure ?? ""}`);
}
if (report.nitsOmitted) console.log(`· ${report.nitsOmitted} further nit(s) summarised rather than listed`);
console.log(`\n${report.summary ?? "(no summary)"}`);
console.log(
  `\n${findings.length} finding(s), ${important.length} Important · ${chunks.length} part(s) · ${path.relative(root, reportPath)} · $${spend.toFixed(4)}`,
);

// Completion, not cleanliness. The gate asks whether the question was put.
//
// ⚠️ An explicit `--range` NEVER stamps, the way `--only` never stamps an eval run. Without this, a review of
// `HEAD~1..HEAD` would earn a stamp the gate reads as covering everything the push carries — a hole this
// file's own convenience flag would have opened. (A rewound `origin/main` still widens the range under a
// valid stamp; that edge is known and unhandled.)
if (opts.range !== undefined) {
  console.log("· no push stamp: --range reviewed a slice, and the gate asks about everything the push carries.");
  process.exit(0);
}
writeFileSync(path.join(root, ".git", "everdict-review-ok"), `${head}\n`);
console.log(
  `· review stamp written for ${head.slice(0, 9)}${important.length > 0 ? " — Important findings above are yours to judge, not the gate's" : ""}`,
);
