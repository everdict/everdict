#!/usr/bin/env node
// ── "EVERY FIX SHIPS A REGRESSION TEST THAT FAILS ON THE PRE-FIX CODE" HAD NO READER ─────────────
//
// CLAUDE.md has carried that sentence since the first week. It is two claims — a fix carries a test, and the
// test was red before the fix — and until 2026-09-06 nothing in this tree read either one. The AI-native SDLC
// audit put the feedback-loop play below its ceiling for exactly that, and its containment drill found the
// row about test files during a fix "stopped only by attention". This check reads the first claim; the commit
// gate (`pnpm ci:commits`) proves the second, in the worktree it already has, using `scripts/fix-proof.mjs`
// for both so the rule and the proof cannot drift apart.
//
// The rule, over every commit this push would carry that is NEWER than this check: a `fix` commit that
// changes source under `packages/**` or `apps/**` also changes a `*.test.ts` file, or its body declares
//
//     Regression-test: none — <why>
//
// A declaration, because a heuristic over commit prose gets re-litigated by every reworded sentence — the
// lesson-evals check paid for that three times. Newer than this check, because the alternative is rewriting
// history, and `pnpm intent-chain` has an opinion about that. Commits under `scripts/`, `evals/` and docs are
// not in scope: their proof is a truth table or a drill, not a Vitest file, and a rule that demanded one there
// would be answered with `expect(true)`.
//
// The predicate is driven over a truth table FIRST, every run. A check whose only corpus is "the commits that
// happen to be ahead of main today" would be green on a day with no fixes and nobody could tell that from
// working.
//
// Reads SOURCE + git history only (no build, no deps), prints every violation, exits 1.
// watches: nothing — reads commit metadata and file lists; it names no live source symbol.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predatesRule, ruleSince, verdictFor } from "./fix-proof.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = "scripts/check-fix-proof.mjs";
const violations = [];
const fail = (message) => violations.push(message);
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const gitOut = (...args) => git(...args).stdout.trim();

// ── the predicate, over constructed commits ──────────────────────────────────────────────────────
const commit = (subject, files, body = "") => ({ subject, body, files });
/** [name, commit, expected kind] */
const TABLE = [
  ["a feat commit is not a fix", commit("feat(domain): add a thing", ["packages/domain/src/a.ts"]), "not-a-fix"],
  [
    "a fix that changes source and a test owes a proof",
    commit("fix(domain): off by one", ["packages/domain/src/a.ts", "packages/domain/src/a.test.ts"]),
    "proof-owed",
  ],
  [
    "a fix that changes source and no test is a violation",
    commit("fix(api): route returns 500", ["apps/api/src/api/x.ts"]),
    "violation",
  ],
  [
    "a fix that declares why it carries no test is declined, not violated",
    commit("fix(api): typo in a log line", ["apps/api/src/api/x.ts"], "Regression-test: none — log wording only"),
    "declined",
  ],
  [
    "a declaration with no reason is not a declaration",
    commit("fix(api): x", ["apps/api/src/api/x.ts"], "Regression-test: none —"),
    "violation",
  ],
  [
    "a fix under scripts/ is outside the rule",
    commit("fix(ci): a gate was wrong about itself", ["scripts/check-x.mjs"]),
    "outside-vitest",
  ],
  [
    "a fix that only changes a .d.ts or a test is outside the rule",
    commit("fix(contracts): types", ["packages/contracts/src/x.d.ts", "packages/contracts/src/y.test.ts"]),
    "outside-vitest",
  ],
  [
    "a fix! (breaking) is still a fix",
    commit("fix!(domain): change the contract", ["packages/domain/src/a.ts"]),
    "violation",
  ],
];
for (const [name, c, expected] of TABLE) {
  const got = verdictFor(c).kind;
  if (got !== expected) fail(`predicate: ${name} — expected \`${expected}\`, got \`${got}\`.`);
}

// ── the commits this push would carry, newer than this check ─────────────────────────────────────
const since = ruleSince(root);
const remote = gitOut("remote").split("\n").filter(Boolean)[0];
const base = `${remote}/main`;
const haveBase = remote !== undefined && git("rev-parse", "--verify", "--quiet", base).status === 0;
let walked = 0;
let fixes = 0;
if (since === undefined) {
  console.log(`· ${self} is not committed yet; the rule applies from the commit that introduces it.`);
} else if (!haveBase) {
  console.log(`· cannot resolve ${base}; only the truth table ran.`);
} else {
  const commits = gitOut("rev-list", "--reverse", `${base}..HEAD`).split("\n").filter(Boolean);
  for (const sha of commits) {
    // Strictly newer: a commit that is an ancestor of the introducing commit predates the rule.
    if (predatesRule(root, sha, since)) continue;
    walked++;
    const subject = gitOut("log", "-1", "--format=%s", sha);
    const body = gitOut("log", "-1", "--format=%b", sha);
    const files = gitOut("show", "--name-only", "--format=", sha).split("\n").filter(Boolean);
    const verdict = verdictFor({ subject, body, files });
    if (verdict.kind === "not-a-fix" || verdict.kind === "outside-vitest") continue;
    fixes++;
    if (verdict.kind === "violation") {
      fail(
        `${sha.slice(0, 9)} "${subject.slice(0, 60)}" changes ${verdict.source.slice(0, 3).join(", ")}${verdict.source.length > 3 ? ", …" : ""} and no test file, and its body has no \`Regression-test: none — <why>\` line. A fix with no test that was red before it is a fix nobody can tell from a coincidence.`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✖ fix-proof: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\n  Every fix ships a regression test that fails on the pre-fix code (CLAUDE.md). Add the test, or say in the\n  commit body why this one needs none. `pnpm ci:commits` proves the test was red on the pre-fix source.",
  );
  process.exit(1);
}
console.log(
  `PASS fix-proof: the rule holds over ${TABLE.length} constructed commits and ${walked} commit(s) ahead of ${haveBase ? base : "(no base)"} newer than the rule (${fixes} fix(es) in scope).`,
);
