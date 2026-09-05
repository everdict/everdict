#!/usr/bin/env node
// watches: nothing — reads a scope of source and records findings; it declares no vocabulary.
//
// `pnpm scan` — the only control here that is NOT change-scoped.
//
// Everything else reads a diff: `pnpm review` reads the range, the gates read what a commit touched,
// `pnpm agent-evals` fires on configuration that changed. All of them are blind to the same thing — code
// nobody has touched. A file written eleven months ago, correct under that week's model and conventions, is
// never looked at again, and both halves go stale: the code around it changed, and the reader got better at
// finding what the old one missed.
//
// `gitleaks` runs over all history every push and answers one question well. It is a deterministic secret
// scanner and is not built for the context-dependent kind — a bound composed with an unbounded neighbour, a
// platform field riding on a producer document, a guard exported and called by nothing. Those are what this
// repository's history is made of, and each was found by somebody happening to look.
//
// ⚠️ A SCAN IS A STATEMENT ABOUT A SCOPE, AT A TIME, UNDER A MODEL. All three go in the record. Omit any and a
// clean scope is indistinguishable from an unscanned one, which is the failure this tool exists to end.
//
// ⚠️ Findings carry a confidence the SCANNER assigned to itself. That is what it is — not a calibration
// anybody measured — and the record says so. Nothing here is auto-applied: a finding enters the tree the way
// every other change does, through the gates.
//
// Usage:
//   node scripts/scan/run.mjs --status          # every scope, last scanned when, under what
//   node scripts/scan/run.mjs --next            # scan the least-recently-read scope
//   node scripts/scan/run.mjs --scope <name>
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOG = path.join(root, ".git", "everdict-scan-log.jsonl");
const DENIED = "Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch";

// The scopes, and why they are cut this way, are in scripts/scan/SCOPES.md. Cut by dependency cone rather
// than by size: a defect class lives in a layer, and reading half a layer answers half a question.
const SCOPES = {
  contracts: ["packages/contracts/src"],
  domain: ["packages/domain/src"],
  application: ["packages/application-execution/src", "packages/application-control/src"],
  adapters: ["packages/db/src", "packages/registry/src", "packages/storage/src", "packages/auth/src"],
  execution: ["packages/backends/src", "packages/drivers/src", "packages/job-runner/src", "packages/orchestrator/src"],
  "agent-runtime": ["packages/agent-runtime/src"],
  api: ["apps/api/src"],
  agent: ["apps/agent/src"],
};

const KNOWN = new Set(["--status", "--next", "--scope", "--model", "--timeout"]);
const argv = process.argv.slice(2);
const opts = { model: "sonnet", timeout: 900 };
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) {
    console.error(`✖ scan: unknown option "${argv[i]}". Known: ${[...KNOWN].join(" ")}`);
    process.exit(1);
  }
  if (argv[i] === "--status" || argv[i] === "--next") {
    opts[argv[i].slice(2)] = true;
    continue;
  }
  const value = argv[++i];
  if (value === undefined) {
    console.error(`✖ scan: ${argv[i - 1]} needs a value.`);
    process.exit(1);
  }
  opts[argv[i - 1].slice(2)] = argv[i - 1] === "--timeout" ? Number(value) : value;
}

const history = existsSync(LOG)
  ? readFileSync(LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : [];

const lastFor = (scope) => history.filter((r) => r.scope === scope).at(-1);
const days = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

// ── --status ─────────────────────────────────────────────────────────────────────────────────────
// Written before the scanning half existed, so the first answer this tool ever gave was an honest "never"
// rather than a silence that reads like "clean".
if (opts.status) {
  console.log("scope           last scanned   model     findings  head");
  for (const scope of Object.keys(SCOPES)) {
    const last = lastFor(scope);
    if (last === undefined) {
      console.log(`${scope.padEnd(15)} NEVER — unscanned is not clean, and nothing here has read it`);
      continue;
    }
    console.log(
      `${scope.padEnd(15)} ${`${days(last.at)}d ago`.padEnd(14)} ${String(last.model).padEnd(9)} ${String(last.findings).padEnd(9)} ${String(last.head).slice(0, 9)}`,
    );
  }
  process.exit(0);
}

// ── which scope ──────────────────────────────────────────────────────────────────────────────────
// Both would be one instruction contradicting the other, and silently letting one win is how a flag teaches
// people that the tool guesses.
if (opts.next && opts.scope !== undefined) {
  console.error("✖ scan: --next and --scope contradict each other. Pass one.");
  process.exit(1);
}
let scope = opts.scope;
if (opts.next) {
  const unscanned = Object.keys(SCOPES).find((s) => lastFor(s) === undefined);
  if (unscanned !== undefined) {
    scope = unscanned;
    console.log(`· --next picked "${scope}": never scanned.`);
  } else {
    scope = Object.keys(SCOPES).sort((a, b) => Date.parse(lastFor(a).at) - Date.parse(lastFor(b).at))[0];
    console.log(`· --next picked "${scope}": least recently scanned, ${days(lastFor(scope).at)} days ago.`);
  }
}
if (scope === undefined) {
  console.error(`✖ scan: name a scope, or use --next / --status. Scopes: ${Object.keys(SCOPES).join(" ")}`);
  process.exit(1);
}
if (SCOPES[scope] === undefined) {
  console.error(`✖ scan: no scope "${scope}". Scopes: ${Object.keys(SCOPES).join(" ")}`);
  process.exit(1);
}

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const head = git("rev-parse", "HEAD").stdout.trim();
const files = git("ls-files", ...SCOPES[scope].map((d) => `${d}/**`))
  .stdout.split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts") && !/\.(test|scenario)\.tsx?$/.test(f));
if (files.length === 0) {
  console.error(
    `✖ scan: scope "${scope}" matched no source files. A scan over an empty corpus would record a clean sheet for nothing.`,
  );
  process.exit(1);
}

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error(
    "✖ scan: the `claude` CLI is not runnable here, so nothing was scanned. That is a FAILURE, not a skip.",
  );
  process.exit(1);
}

const wt = path.join(tmpdir(), `everdict-scan-${process.pid}`);
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
  console.error("✖ scan: could not create the throwaway worktree.");
  process.exit(1);
}

const prompt = [
  `Scan the scope "${scope}" of this repository: ${SCOPES[scope].join(", ")} — ${files.length} source files.`,
  "This is NOT a diff review. Nothing here has changed recently; the question is what is wrong in code nobody",
  "has looked at, under the conventions this repository holds today.",
  "",
  "Read `.claude/rules/protocol.md` and `.claude/rules/ci.md` first: they record the defect classes this",
  "repository has actually paid for. Look for those classes specifically —",
  "  · a field the PLATFORM authors riding on a document a PRODUCER submits, and then acted on;",
  "  · a failed read consumed as an empty result rather than as a third value;",
  "  · identity re-derived from rendered output instead of carried from the source;",
  "  · a bound composed with an unbounded neighbour;",
  "  · an exported guard that nothing calls, or an optional dependency whose absence widens a decision;",
  "  · a conditional write whose refusal path no test can reach.",
  "",
  "Read the files. Do not guess from names.",
  "",
  "Answer with a JSON object and nothing else:",
  '{"findings":[{"file":"...","line":123,"class":"one of the classes above or `other`",',
  '"confidence":"high|medium|low","summary":"one sentence","failure":"inputs or state -> wrong output"}],',
  '"read":0,"summary":"two sentences: what this scope is, and the single thing most worth attention"}',
  "",
  "`confidence` is your own rating of whether this is real. Say low when you could not confirm it by reading;",
  "an unconfirmed suspicion recorded as high is worse than not recording it.",
].join("\n");

let envelope;
try {
  console.log(`▶ scan · ${scope} · ${files.length} file(s) · model ${opts.model}\n`);
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
    console.error(
      `✖ scan: timed out after ${opts.timeout}s — nothing recorded, because a partial scan recorded as a scan is the false clean sheet.`,
    );
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`✖ scan: claude exited ${res.status}. ${(res.stderr ?? "").slice(0, 400)}`);
    process.exit(1);
  }
  envelope = JSON.parse(res.stdout);
} finally {
  teardown();
}

const text = String(envelope?.result ?? "");
const json = /\{[\s\S]*\}/.exec(text);
let report;
let structured = true;
try {
  report = JSON.parse(json?.[0] ?? "");
} catch {
  // ⚠️ AN UNSTRUCTURED ANSWER IS STILL A READING. The first version exited here and recorded nothing, and the
  // pass it discarded that way had found `PgWorkspaceStore.delete()`'s 18-table allowlist against 60 more
  // tenant-scoped tables — a real defect thrown away because the model answered in prose. The sink one
  // directory over already had this right: it records an undecodable payload as a fact about the exporter
  // rather than dropping it.
  //
  // Recorded, and marked: `structured: false` keeps it out of the findings band, because a prose answer has no
  // countable finding total and averaging a guess into a series is worse than a gap in it.
  structured = false;
  report = {
    unstructured: true,
    text,
    findings: [],
    summary: "(the scanner answered in prose; the text is in this file)",
  };
  console.error(
    "! scan: the answer was not the findings envelope. Recording the prose — a reading nobody can count is still a reading.\n",
  );
}

const findings = Array.isArray(report.findings) ? report.findings : [];
const order = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => (order[a.confidence] ?? 3) - (order[b.confidence] ?? 3));

writeFileSync(
  path.join(root, ".git", `everdict-scan-${scope}.json`),
  JSON.stringify(
    { at: new Date().toISOString(), scope, head, model: opts.model, files: files.length, ...report },
    null,
    2,
  ),
);
appendFileSync(
  LOG,
  `${JSON.stringify({
    at: new Date().toISOString(),
    scope,
    head,
    model: opts.model,
    files: files.length,
    structured,
    findings: structured ? findings.length : null,
    cost: Number((envelope.total_cost_usd ?? 0).toFixed(4)),
  })}\n`,
);

for (const f of findings) {
  console.log(
    `${f.confidence === "high" ? "‼" : f.confidence === "medium" ? "!" : "·"} [${f.class}] ${f.file}${f.line ? `:${f.line}` : ""}`,
  );
  console.log(`    ${f.summary}\n    ${f.failure ?? ""}`);
}
console.log(`\n${report.summary ?? "(no summary)"}`);
console.log(
  `\n${structured ? `${findings.length} finding(s)` : "an unstructured reading"} in ${scope} at ${head.slice(0, 9)} under ${opts.model} · .git/everdict-scan-${scope}.json · $${(envelope.total_cost_usd ?? 0).toFixed(4)}`,
);
console.log(
  "· confidences are the scanner's own rating, not a calibration. Nothing here is applied; findings enter the tree through the gates.",
);
