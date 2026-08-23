#!/usr/bin/env node
// Local CI parity gate — runs everything .github/workflows/ci.yml runs, in the same order.
// Never `git push` red: this script is the "confirm before push" rule (.claude/rules/ci.md, skill `ci`).
// On success with a CLEAN tree it stamps .git/everdict-ci-ok with the HEAD sha; the Claude Code
// PreToolUse hook (scripts/hooks/pre-push-gate.mjs) blocks `git push` unless that stamp matches HEAD
// (CI validates the pushed commit, so a dirty-tree pass proves nothing about HEAD).
// Plain Node, no external deps. Usage: `pnpm ci:local` (or `node scripts/ci-local.mjs`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GITLEAKS_VERSION = "8.24.3"; // keep in sync with ci.yml
const gitleaksCache = path.join(homedir(), ".cache", "everdict", `gitleaks-${GITLEAKS_VERSION}`, "gitleaks");

function run(label, command, args, opts = {}) {
  const startedAt = Date.now();
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(command, args, { cwd: root, stdio: "inherit", ...opts });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (res.status !== 0) {
    console.error(`\n✖ CI-PARITY RED — "${label}" failed after ${seconds}s. Fix it, then re-run pnpm ci:local.`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${label} (${seconds}s)\n`);
}

function resolveGitleaks() {
  const onPath = spawnSync("gitleaks", ["version"], { stdio: "ignore" });
  if (!onPath.error) return "gitleaks";
  if (existsSync(gitleaksCache)) return gitleaksCache;
  process.stdout.write(`\n▶ installing gitleaks v${GITLEAKS_VERSION} (one-time, to ${path.dirname(gitleaksCache)})\n`);
  mkdirSync(path.dirname(gitleaksCache), { recursive: true });
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  const dl = spawnSync("bash", ["-c", `curl -sL ${url} | tar xz -C ${path.dirname(gitleaksCache)} gitleaks`], {
    stdio: "inherit",
  });
  if (dl.status !== 0 || !existsSync(gitleaksCache)) {
    console.error("✖ could not install gitleaks — install it manually and re-run.");
    process.exit(1);
  }
  return gitleaksCache;
}

// Job 1 — core (identical order to ci.yml).
run("pnpm lint", "pnpm", ["lint"]);
run("pnpm typecheck", "pnpm", ["typecheck"]);
run("pnpm test", "pnpm", ["test"]);
run("pnpm build", "pnpm", ["build"]);
run("pnpm cone", "pnpm", ["cone"]);
run("pnpm web-imports", "pnpm", ["web-imports"]);
run("pnpm migrations", "pnpm", ["migrations"]);
run("pnpm artifact-frame", "pnpm", ["artifact-frame"]);
// ── CAN THE CONVENTIONS STILL FIRE? ───────────────────────────────────────────────────────────────
// `.claude/rules/*` are injected by path glob. A rule pointed at code that MOVED is not a weak rule, it is
// an absent one — and absent silently. Two were found dead this way (`suite.md` at the folded
// `packages/suite`, `workspace-integrations.md` at six files the api-layer refactor relocated), both holding
// invariants later reviews found broken.
run("pnpm convention-harness", "pnpm", ["convention-harness"]);
// ── DOES THE SUITE ACTUALLY CATCH THIS? (arch-review 53, Wave F) ──────────────────────────────────
// Neutralize each protocol one at a time and require the suite that claims to enforce it to go RED. A green
// suite proves the tests pass; this proves they would fail if the protocol were removed — which is the
// difference this program has twice paid for learning (a scanner draft that was green over the defect it was
// written for, and a judgment fixture that certified a gap).
run("pnpm protocol-mutations", "pnpm", ["protocol-mutations"]);
run("pnpm plugin-manifests", "pnpm", ["plugin-manifests"]);
run("pnpm docs-check", "pnpm", ["docs-check"]);
run("pnpm constructed-casts", "pnpm", ["constructed-casts"]);
run("pnpm guarded-doubles", "pnpm", ["guarded-doubles"]);
run("pnpm language-policy", "pnpm", ["language-policy"]);
run("pnpm source-bytes", "pnpm", ["source-bytes"]);
run("empty-env boot contract", "node", ["scripts/live/empty-env-boot.mjs"]);

// Job 2 — web (self-contained; contracts d.ts already exists via the root build above).
run("web lint", "pnpm", ["-F", "@everdict/web", "lint"]);
run("web build", "pnpm", ["-F", "@everdict/web", "build"]);

// Job 3 — secret scan (full history, same flags as ci.yml).
run("gitleaks (full history)", resolveGitleaks(), [
  "git",
  ".",
  "--config",
  ".gitleaks.toml",
  "--log-opts=--all",
  "--no-banner",
]);

// Stamp — only a clean tree proves HEAD is what we just validated.
//
// `git diff HEAD` + untracked, not `status --porcelain`: the latter also compares the worktree to the INDEX,
// and in a tree several sessions commit into through temp indexes the real one lags behind the ref — so a
// checkout whose CONTENT is exactly HEAD's reads as dirty and no stamp is written. The question is whether
// this checkout IS the commit, which is what the stamp attests; untracked files count, because an untracked
// source file is part of what was just built.
// Same reason as `ci:commits`: `ls-files --others` consults the index, and a stale one reports files the
// ref already has as untracked. `read-tree` re-points the index at HEAD and `--refresh` re-stats it;
// neither touches the worktree.
spawnSync("git", ["read-tree", "HEAD"], { cwd: root });
spawnSync("git", ["update-index", "--refresh", "-q", "--unmerged"], { cwd: root });
const dirty = [
  spawnSync("git", ["diff", "HEAD", "--name-only"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).stdout.trim(),
]
  .filter(Boolean)
  .join("\n");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
if (dirty) {
  console.log(
    "\n✓ CI-PARITY GREEN — but the tree is DIRTY, so no push stamp was written.\n  Commit first, then re-run pnpm ci:local (turbo cache makes the re-run fast).",
  );
  process.exit(0);
}
// The stamp lives in the REAL git directory, which is not `<root>/.git` in a linked worktree — there `.git`
// is a FILE pointing at the shared repo, and writing through it fails with ENOTDIR after every check has
// already passed. That matters because a clean worktree is exactly how this gate is run when the main tree
// holds another session's work in progress: the one arrangement that needs the stamp most was the one that
// could not write it.
//
// It is written to the worktree's own git dir AND to the COMMON one (the main tree's `.git`, identical to the
// first outside a worktree). The stamp attests a fact about the SHA — "this commit passed the full gate on a
// clean tree" — not about which checkout ran it, and the pre-push hook reads the common location. Keeping it
// worktree-local would mean validating a commit and then being refused permission to push the very commit
// that was validated.
// ⚠️ Both paths resolve against ROOT, never against gitDir. `--git-common-dir` answers RELATIVE to the cwd it was
// asked from (a plain checkout says `.git`), so resolving it against the git dir produced `<root>/.git/.git` — a
// directory that does not exist. Every one of the twelve stages passed, the real stamp was written, and then the
// write to that phantom path threw ENOENT: exit 1 with no "GREEN" line, which reads as a red gate. It never showed
// up in a linked worktree because there the answer is already absolute and the wrong base is ignored.
const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).stdout.trim();
const commonDir = path.resolve(
  root,
  spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).stdout.trim(),
);
// ── THE STAMP IS A LEDGER, NOT A LATCH (arch-review 57 follow-up) ─────────────────────────────────
//
// It used to hold one sha, and the hook compared it to HEAD. That verifies the TIP of a push and nothing
// else: a batch of eight commits pushed together had one gated commit and seven that had never been built,
// while the split history advertises itself as bisectable. `git bisect` landing on one of those seven is
// asking a question the tree cannot answer.
//
// So every gated commit appends a line, and the line records WHICH gate it passed — `full` here, `fast` from
// `scripts/ci-commits.mjs`. A fast-stamped commit is not a full-stamped one, and writing them alike would be
// the same lie one level down. The hook requires a stamp for every commit being pushed and `full` for the tip.
// Bounded: the last 200 lines, which is more history than any push spans.
const LEDGER_LINES = 200;
for (const dir of new Set([gitDir, commonDir])) {
  const file = path.join(dir, "everdict-ci-ok");
  const prior = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  // A bare sha is a pre-ledger stamp; keep it readable as `full`, which is what it attested.
  const kept = prior.map((l) => (l.includes(" ") ? l : `${l} full`)).filter((l) => !l.startsWith(head));
  writeFileSync(file, `${[...kept, `${head} full`].slice(-LEDGER_LINES).join("\n")}\n`);
}
console.log(`\n✓ CI-PARITY GREEN — stamped ${head.slice(0, 9)} full — safe to push.`);
