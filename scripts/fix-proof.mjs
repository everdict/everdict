// The fix-proof rule and its proof, as functions `scripts/check-fix-proof.mjs` (the rule) and
// `scripts/ci-commits.mjs` (the proof) both consume — one definition, so the two cannot drift.
//
// CLAUDE.md has said since the first week: "Every `fix:` ships a regression test that fails on the pre-fix
// code." Two claims in one sentence, and until 2026-09-06 nothing read either. The AI-native SDLC audit
// scored the feedback loop below its ceiling for it: the playbook's form of this control is a hook that locks
// test files during a fix task, so an agent cannot make a test pass by editing it. This repository's rule is
// the inverse — a fix must ADD a test — and the property both are after is the same: the test was red
// before the fix and green after, on the pre-fix and post-fix code respectively. That property is provable
// from the commit graph, which is where this file proves it.
//
// Two halves:
//   · the RULE (`verdictFor`): a `fix` commit that changes source under packages/** or apps/** either also
//     changes a test file, or declares in its body why not — `Regression-test: none — <why>`. A declaration,
//     not a heuristic over the message, in the form `lessons/` and `intent/` already use.
//   · the PROOF (`proveInWorktree`): with the commit checked out in a throwaway worktree, revert its source
//     hunks to the parent, run its test files, and require them to FAIL. A test that passes on the pre-fix
//     code never proved the bug was gone (skill `testing`, the vacuous-pass rules).
//
// Scope is packages/** and apps/** because that is where Vitest runs. A fix under scripts/ is proved by its
// own truth table (`pnpm guardrails` is the pattern) and a fix under evals/ by its drill; neither has a test
// file for this rule to find, and asking for one would teach people to write `expect(true)`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const SOURCE = /^(packages|apps)\/[^/]+\/.*\.(ts|tsx)$/;
const TEST = /\.test\.tsx?$/;
const DECLARATION = /^Regression-test:\s*none\s*[—-]\s*(\S.*)$/m;

/**
 * @param {{ subject: string, body: string, files: string[] }} commit
 * @returns {{ kind: "not-a-fix" } | { kind: "outside-vitest" } | { kind: "declined", why: string }
 *   | { kind: "proof-owed", source: string[], tests: string[] } | { kind: "violation", source: string[] }}
 */
export function verdictFor({ subject, body, files }) {
  if (!/^fix(\(|!|:)/.test(subject)) return { kind: "not-a-fix" };
  const source = files.filter((f) => SOURCE.test(f) && !TEST.test(f) && !f.endsWith(".d.ts"));
  const tests = files.filter((f) => SOURCE.test(f) && TEST.test(f));
  if (source.length === 0) return { kind: "outside-vitest" };
  if (tests.length > 0) return { kind: "proof-owed", source, tests };
  const declared = DECLARATION.exec(body);
  if (declared) return { kind: "declined", why: declared[1].trim() };
  return { kind: "violation", source };
}

/**
 * The commit that introduced the rule, or undefined while it is uncommitted. Commits that are ancestors of it
 * predate the rule and are outside it — read from git rather than kept as a constant, so history is never
 * rewritten to satisfy a check that arrived later. `check-fix-proof.mjs` and `ci-commits.mjs` both ask.
 */
export function ruleSince(root) {
  const log = spawnSync("git", ["log", "--diff-filter=A", "--format=%H", "--", "scripts/check-fix-proof.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  if (log.status !== 0) return undefined;
  return log.stdout.split("\n").filter(Boolean).at(-1);
}

/** True when `sha` predates the rule (is an ancestor of the commit that introduced it, or the rule is uncommitted). */
export function predatesRule(root, sha, since = ruleSince(root)) {
  if (since === undefined) return true;
  return spawnSync("git", ["merge-base", "--is-ancestor", sha, since], { cwd: root }).status === 0;
}

/** `packages/<name>` or `apps/<name>` — the workspace package a path belongs to. */
const packageDirOf = (file) => file.split("/").slice(0, 2).join("/");

/**
 * Prove, inside a worktree already checked out at `sha` with dependencies installed, that the commit's tests
 * fail on the pre-fix code. Restores the worktree to `sha` before returning, whatever happened.
 *
 * @param {{ wt: string, sha: string, source: string[], tests: string[], log?: (line: string) => void }} args
 * @returns {{ ok: true, ran: string[] } | { ok: false, why: string }}
 */
export function proveInWorktree({ wt, sha, source, tests, log = () => {} }) {
  const git = (...args) => spawnSync("git", args, { cwd: wt, encoding: "utf8" });
  const pnpm = (args, cwd = wt) => spawnSync("pnpm", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const nameOf = (pkgDir) => {
    try {
      return JSON.parse(readFileSync(path.join(wt, pkgDir, "package.json"), "utf8")).name;
    } catch {
      return undefined;
    }
  };
  const parent = `${sha}^`;
  const sourcePkgs = [...new Set(source.map(packageDirOf))];
  const testPkgs = [...new Set(tests.map(packageDirOf))];
  // A sibling package's dist is what a cross-package import resolves to (turbo: test dependsOn ^build), so a
  // source revert in one package is invisible to a test in another until that package is rebuilt.
  const rebuild = sourcePkgs.filter((p) => !testPkgs.includes(p));

  const restore = () => {
    git("checkout", "--quiet", sha, "--", ...source);
    for (const pkgDir of rebuild) {
      const name = nameOf(pkgDir);
      if (name) pnpm(["-F", name, "build"]);
    }
  };

  const redOn = [];
  try {
    // Revert the source to the parent. A file the commit ADDED has no parent version: it is removed.
    for (const file of source) {
      if (git("cat-file", "-e", `${parent}:${file}`).status === 0) {
        const co = git("checkout", "--quiet", parent, "--", file);
        if (co.status !== 0) return { ok: false, why: `could not revert ${file} to ${parent}: ${co.stderr.trim()}` };
      } else {
        rmSync(path.join(wt, file), { force: true });
      }
    }
    for (const pkgDir of rebuild) {
      const name = nameOf(pkgDir);
      if (!name)
        return { ok: false, why: `${pkgDir} has no readable package.json, so its pre-fix dist cannot be built` };
      log(`  ▶ rebuilding ${name} at the pre-fix source`);
      const built = pnpm(["-F", name, "build"]);
      if (built.status !== 0) {
        // The pre-fix source may not compile — that IS a red on the pre-fix code, for a test that imports it.
        log(`    (pre-fix ${name} does not build: ${(built.stderr ?? "").trim().split("\n").at(-1) ?? ""})`);
      }
    }
    for (const pkgDir of testPkgs) {
      const name = nameOf(pkgDir);
      if (!name) return { ok: false, why: `${pkgDir} has no readable package.json, so its tests cannot be run` };
      const files = tests.filter((t) => packageDirOf(t) === pkgDir).map((t) => path.relative(pkgDir, t));
      // Every named file must be FOUND, or "no tests ran" reads as red for the wrong reason.
      for (const f of files) {
        if (!existsSync(path.join(wt, pkgDir, f))) return { ok: false, why: `${pkgDir}/${f} is not in the worktree` };
      }
      log(`  ▶ ${name}: vitest run ${files.join(" ")} — on the pre-fix source, expecting RED`);
      const res = pnpm(["-F", name, "exec", "vitest", "run", ...files], path.join(wt, pkgDir));
      if (res.status === 0) {
        return {
          ok: false,
          why: `${files.join(", ")} PASSED on the pre-fix code. A test that is green before the fix never proved the bug was gone; it proves only that it runs.`,
        };
      }
      redOn.push({ name, pkgDir, files });
    }
  } finally {
    restore();
  }
  // ⚠️ RED FOR THE RIGHT REASON. A non-zero exit on the pre-fix source is also what a missing runner, a broken
  // config or a file vitest never collected produces — and every one of those would have read as "proved". So
  // the same files run again on the RESTORED tree and must be GREEN: red before, green after, same command.
  // A test that is red both times was never a test of this fix.
  for (const { name, pkgDir, files } of redOn) {
    log(`  ▶ ${name}: vitest run ${files.join(" ")} — on the fixed source, expecting GREEN`);
    const res = pnpm(["-F", name, "exec", "vitest", "run", ...files], path.join(wt, pkgDir));
    if (res.status !== 0) {
      return {
        ok: false,
        why: `${files.join(", ")} is not green on the fixed code either (vitest exited ${res.status}), so its red on the pre-fix code proves nothing — the runner may not have run it at all.\n${(res.stderr ?? "").trim().split("\n").slice(-5).join("\n")}`,
      };
    }
  }
  return { ok: true, ran: redOn.flatMap((r) => r.files.map((f) => `${r.pkgDir}/${f}`)) };
}
