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
// ── A FIXTURE THE FIX ITSELF FORCES, NAMED BY THE AUTHOR ─────────────────────────────────────────────
//
// The proof below requires EVERY test file a fix touches to go red on the pre-fix source. Some cannot, and
// not because anybody was careless: a commit that changes a TYPE its fixtures are written against forces
// those fixtures to move WITH it, and such a file is green before the fix by construction. Measured on
// `891eb99b` — three of its seventeen test files — and the split was tried in both directions and is
// impossible: put them before the fix and they do not compile (`'measurement' does not exist in type
// 'MeasuredScore'`), put them after and the fix's own suite is red. They belong in that commit, the commit
// is correctly formed, and the rule refused it.
//
// So the author NAMES them, in the body, in the same declaration grammar `Regression-test: none` uses. This
// is deliberately not a heuristic: a check that guessed which greens are "just fixtures" would be a check
// that admits the vacuous proofs this whole function exists to refuse. A person writes the claim, a reviewer
// reads it, and `git log --grep` finds every one.
//
// ⚠️ IT CANNOT DECLARE AWAY THE WHOLE PROOF. A fix that names every test file it touches is refused as a
// violation, exactly as a fix that ships no test at all is — the declaration exempts fixtures from a proof,
// never a commit from having one.
// ⚠️ THE DASH IS SURROUNDED BY SPACE, BECAUSE THE VALUES CONTAIN THE SEPARATOR. `Regression-test: none — <why>`
// can write `[—-]` with optional space around it: "none" has no hyphen in it. These values are PATHS, and
// `packages/application-control/...` does — so the lazy match found `packages/application` and reported the
// rest of the path as the reason, then refused the commit for declaring a file it does not touch. The check
// caught it, which is the check working; the grammar is what was wrong.
const FIXTURE_DECLARATION = /^Fixture-only:\s*(\S[^\n]*?)\s+[—-]\s+(\S.*)$/m;

/** The test files a commit declared as fixtures its own change forces — paths, comma-separated. */
export function declaredFixtures(body) {
  const m = FIXTURE_DECLARATION.exec(body);
  if (!m?.[1]) return [];
  return m[1]
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * @param {{ subject: string, body: string, files: string[] }} commit
 * @returns {{ kind: "not-a-fix" } | { kind: "outside-vitest" } | { kind: "declined", why: string }
 *   | { kind: "proof-owed", source: string[], tests: string[] } | { kind: "violation", source: string[] }}
 */
export function verdictFor({ subject, body, files }) {
  if (!/^fix(\(|!|:)/.test(subject)) return { kind: "not-a-fix" };
  const source = files.filter((f) => SOURCE.test(f) && !TEST.test(f) && !f.endsWith(".d.ts"));
  const touched = files.filter((f) => SOURCE.test(f) && TEST.test(f));
  if (source.length === 0) return { kind: "outside-vitest" };
  // A declared fixture is exempt from the proof, not from the commit: it still ships, it is still reviewed,
  // and what it stops being is EVIDENCE. A path named here that the commit does not touch is a stale
  // declaration and is reported rather than ignored — a reason that outlived its subject reads as permission.
  const fixtures = declaredFixtures(body);
  const stale = fixtures.filter((f) => !touched.includes(f));
  if (stale.length > 0) return { kind: "stale-fixture-declaration", stale };
  const tests = touched.filter((f) => !fixtures.includes(f));
  if (tests.length > 0) return { kind: "proof-owed", source, tests, ...(fixtures.length > 0 ? { fixtures } : {}) };
  // Every test file declared a fixture, or none was shipped at all: either way the fix has no proof, and the
  // two are the same refusal because they leave the same hole.
  const declared = DECLARATION.exec(body);
  if (declared && touched.length === 0) return { kind: "declined", why: declared[1].trim() };
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
  //
  // ⚠️ ASKED PER TEST, NOT PER PACKAGE SET. This read `sourcePkgs.filter((p) => !testPkgs.includes(p))` — a
  // package was excluded from the rebuild as soon as ANY of the commit's tests lived in it. A commit that
  // changes one package's source and carries BOTH an in-package test and a cross-package one therefore
  // rebuilt nothing, and the cross-package counterexample ran against the FIXED dist: it passed, and the
  // prover read that as "green on the pre-fix code" and refused a commit whose proof was real.
  //
  // It is a FALSE REFUSAL, which is the half of a predicate nobody tests — every case written for this
  // function was a proof that should be rejected, and none was a proof that must be admitted (the
  // both-sides law in skill `code-review`). It was found twice in one push, on two independent commits, and
  // both times it read as the author's mistake rather than as the check's.
  //
  // The two cases differ and the question separates them: a test in the SAME package reads its package's
  // SOURCE, so the revert alone is enough; a test in ANOTHER package reads this one's DIST, so the rebuild is
  // what makes the revert visible at all. So a source package is rebuilt whenever the commit has any test
  // outside it — a superset of what was rebuilt before, never less.
  //
  // ⚠️ AND THAT SUPERSET HAS A PRICE, STATED RATHER THAN CLAIMED AWAY. Reverting more packages means a test
  // can now go red because a symbol its sibling has not grown yet cannot be imported, rather than because the
  // invariant is gone — and the restored-tree GREEN check below does NOT separate those two, since a missing
  // export is red before and green after exactly like a real proof. That hazard is not new (a source package
  // with no tests of its own was always rebuilt) and it is not closed here; what changes is that a signature
  // change now reaches it more often. The honest separation is to read WHY vitest went red, which this
  // function does not do. Until it does, a commit whose only red is an unresolved import has a proof this
  // gate cannot distinguish from a real one.
  const rebuild = sourcePkgs.filter((p) => tests.some((t) => packageDirOf(t) !== p));

  const restore = () => {
    git("checkout", "--quiet", sha, "--", ...source);
    for (const pkgDir of rebuild) {
      const name = nameOf(pkgDir);
      if (name) pnpm(["-F", name, "build"]);
    }
  };

  const redOn = [];
  // Files that exited 0 having run no test at all — see the note at the exit-0 arm below.
  const inconclusive = [];
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
    // ⚠️ ONE FILE PER INVOCATION, BECAUSE THE VERDICT IS PER FILE. Files were run per PACKAGE, in one call, and
    // a non-zero exit credited every file in the group as "ran and went red". A commit touching both
    // `apps/api/src/composition/foo.test.ts` (legitimately red) and `apps/api/src/trust/bar.trust.test.ts`
    // (env-gated, skips here) is one package and one call: foo makes it exit non-zero, and bar — which
    // executed nothing — is certified as proof. That is the "a green exit with nothing run is not a green"
    // failure this function was written to close, reopened one level up at group granularity. Found by
    // `pnpm review` on the change that closed the first one.
    for (const test of tests) {
      const pkgDir = packageDirOf(test);
      const name = nameOf(pkgDir);
      if (!name) return { ok: false, why: `${pkgDir} has no readable package.json, so its tests cannot be run` };
      const files = [path.relative(pkgDir, test)];
      // Every named file must be FOUND, or "no tests ran" reads as red for the wrong reason.
      for (const f of files) {
        if (!existsSync(path.join(wt, pkgDir, f))) return { ok: false, why: `${pkgDir}/${f} is not in the worktree` };
      }
      log(`  ▶ ${name}: vitest run ${files.join(" ")} — on the pre-fix source, expecting RED`);
      const res = pnpm(["-F", name, "exec", "vitest", "run", ...files], path.join(wt, pkgDir));
      if (res.status === 0) {
        // ⚠️ A GREEN EXIT WITH NOTHING RUN IS NOT A GREEN. An env-gated suite — every `*.trust.test.ts` here
        // gates on `EVERDICT_TRUST_SUITE=1` plus its infrastructure — skips in this worktree and exits 0, and
        // reading that as "passed on the pre-fix code" condemns exactly the commits that did the most work:
        // a fix certified against a real engine, whose in-process shape test DOES go red, refused because its
        // sibling could not run. Found by this gate on `fix(db): deleting a workspace threw`, whose trust
        // scenario needs a Postgres and whose unit test went red as designed.
        //
        // The distinction the repository already makes elsewhere, pointed the other way: `trust-suite.mjs`
        // treats a skipped scenario as a FAILED certification, because a certification is a claim. A PROOF is
        // not a claim — a file that ran nothing has said nothing, so it is inconclusive here and some OTHER
        // file the commit changed has to carry the proof. If none can, the commit is refused below with that
        // as the reason, which is a different sentence from "your test was already green".
        if (ranNothing(res.stdout ?? "")) {
          log("    (inconclusive: nothing ran — an env-gated suite proves nothing without its infrastructure)");
          inconclusive.push(...files.map((f) => `${pkgDir}/${f}`));
          continue;
        }
        return {
          ok: false,
          why: `${files.join(", ")} PASSED on the pre-fix code. A test that is green before the fix never proved the bug was gone; it proves only that it runs.`,
        };
      }
      // A red exit is not yet a proof either: a file that ran nothing AND exited non-zero did so for some
      // other reason (a missing runner, a config error), and the restored-tree GREEN check below is what
      // separates those. Recorded per file so that check names the same one file.
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
  // Every file the commit touched ran nothing, so the fix has no proof here — a different refusal from
  // "already green", and one whose repair is to add a test that can run rather than to change the one that could not.
  if (redOn.length === 0)
    return {
      ok: false,
      why: `no test this commit changed could run on the pre-fix code (${inconclusive.join(", ")} ran nothing — an env-gated suite without its infrastructure). A fix is proved by a test that executes here; certify the gated one with its own suite and ship a test this gate can drive.`,
    };
  return {
    ok: true,
    ran: redOn.flatMap((r) => r.files.map((f) => `${r.pkgDir}/${f}`)),
    ...(inconclusive.length > 0 ? { inconclusive } : {}),
  };
}

// Did vitest run anything? An all-skipped file exits 0 and reports only skips; a real pass reports a nonzero
// `passed` count. Read from the summary line rather than from the exit code, which cannot tell them apart.
function ranNothing(stdout) {
  const passed = /Tests\s[^\n]*?(\d+)\s+passed/.exec(stdout);
  return passed === null || Number(passed[1]) === 0;
}
