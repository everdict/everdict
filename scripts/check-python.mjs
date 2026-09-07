#!/usr/bin/env node
// watches: nothing — it runs `.py` files through python3; it names no live TypeScript symbol.
//
// ── TWENTY-NINE GATES, AND NOT ONE OF THEM COULD SEE A `.py` FILE ────────────────────────────────
//
//     $ grep -rn "\.py\b" package.json .github/workflows/ci.yml scripts/ci-local.mjs
//     (nothing)
//
// No linter, no type checker, no test runner reached `examples/bundles/**`. That was tolerable while the
// Python there was glue. It stopped being tolerable when `sbench_stage.py` — the file that decides WHAT THE
// EXAM IS, whose mispaired digest scores a correct agent zero and whose docstring says exactly that — was
// fixed FIVE TIMES IN TWO DAYS, each fix finding the previous one's defect, every one found by a person
// running it by hand against the real 912-instruction dataset because there was no other way to run it:
//
//     52bd0e77  a question the grader could not ask was being spent as the agent's wrong answer
//     145789dc  an empty context matched an empty context, and refused ten cases on it
//     67db140f  the identity is asked first, or a swap of two equal contexts refuses a correct key
//     f7eaccda  the free-text channel that skipped the exclusion
//     26ecdfc6  "a human should read these" over 220 cases is 220 findings nobody reads
//
// Meanwhile the TypeScript beside it could not merge a `catch` without four gates having an opinion.
//
// ── WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────────────────────
//
// Two things, both of which need nothing but `python3`:
//
//   1. every tracked `.py` COMPILES. `py_compile` is a parser, not a type checker — it catches the class
//      that costs a full staging run to discover, and it costs a second.
//   2. every `test_*.py` and every declared SELF_TEST RUNS AND PASSES. ⚠️ A test that cannot run is a
//      FAILURE, never a skip — the same rule `scripts/trust/trust-suite.mjs` applies to a scenario that
//      skipped, and for the same reason: a required check that quietly skips is worse than no check. That
//      constraint is what put the staging DECISION in its own module (`sbench_pairing.py`) instead of behind
//      three workbooks and openpyxl, so `test_sbench_stage.py` needs nothing but the interpreter.
//
// ── THE FIVE SUITES THAT HAVE NEVER RUN, DECLARED RATHER THAN QUIETLY ABSENT ─────────────────────
//
// Writing this gate found something its author did not go looking for: `clients/python/tests/` (117 lines
// over the published client) and `examples/servers/spica-playwright-server/tests/` (360 lines) have existed
// for as long as they have existed and NOTHING HAS EVER RUN THEM. Not this gate, not `ci.yml`, not a
// developer loop — there is no `pytest` anywhere in the repository's tooling. They are not skipped; they
// were never wired.
//
// They need `pytest`, `httpx` and an editable install, which this gate deliberately does not do: installing
// packages is a decision about somebody's machine and about CI minutes, and it belongs to the maintainer,
// not to a check that ran because a push happened. So they are DECLARED — named, with what each needs, and
// counted on every run. A declared gap is a debt somebody can pay; an unwired suite is one nobody can see.
//
// `NEEDS` is a RATCHET in both directions: a new dependency-bearing test that is not declared FAILS, and a
// declared entry whose file is gone FAILS — a reason that outlived its subject reads as permission.
//
// It does NOT install anything, lint, or type-check. A linter would be the next thing to add and it needs a
// dependency; this needs none, and a gate that exists today beats a better one that needs a decision first.
//
// Reads SOURCE only (no build, no deps beyond python3), prints every violation, exits 1.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Modules whose `__main__` IS a self-test. Named rather than globbed: `ci.yml` globbed
// `examples/bundles/*/scripts/sbench_position.py` under a comment saying two files' self-tests run there,
// and a glob that names one file is a list written in the least readable way available.
const SELF_TESTS = ["examples/bundles/spreadsheetbench/scripts/sbench_position.py"];

// Test files this gate cannot run, each with the module it is missing and what closing it costs. The value
// is the import that fails FIRST; any other failure from these files is a real violation, not a gap.
// ⚠️ THIS LIST WAS FIVE ENTRIES AND 477 LINES, AND THREE OF THEM NEEDED NOTHING. `intent/2026-09-05-
// python-suites-that-have-never-run` was filed against this list: every one of those files looked like
// coverage and none had ever been executed by anything. Reading what each actually imports split them
// cleanly — the published client used pytest for one thing (`pytest.raises`, eight lines of `contextlib`),
// the registry suite imports only stdlib-reachable modules, and four of the launch suite's five claims need
// no dependency at all. Those now RUN, on every `pnpm python`, with nothing but the interpreter — the same
// move `sbench_pairing.py` made, and the reason `pnpm ci:local` still works on a clean checkout.
//
// What is left is the half that genuinely needs the example server's declared dependencies (fastapi, httpx,
// psutil). Installing them is a decision about CI minutes and about somebody's machine, and a gate that ran
// because a push happened does not get to make it — so it stays declared, and it is declared PRECISELY: the
// one launch claim that needs psutil is its own file, because leaving it inside `test_launch.py` made four
// tests that need nothing unrunnable for the sake of a fifth. That is the accounting error the intent named.
const NEEDS = new Map([
  ["examples/servers/spica-playwright-server/tests/test_api.py", "httpx"],
  ["examples/servers/spica-playwright-server/tests/test_launch_process_ownership.py", "psutil"],
  ["examples/servers/spica-playwright-server/tests/test_service.py", "pytest"],
]);

const files = execFileSync("git", ["ls-files", "*.py"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 })
  .split("\n")
  .filter(Boolean);

// An empty corpus reads exactly like coverage. Refuse rather than report.
if (files.length === 0) {
  console.error("✖ python: no .py files are tracked. Refusing to report over an empty corpus.");
  process.exit(1);
}
const tests = [...files.filter((f) => path.basename(f).startsWith("test_")), ...SELF_TESTS];
for (const f of SELF_TESTS)
  if (!files.includes(f)) {
    console.error(`✖ python: SELF_TESTS names ${f}, which is not tracked. A list pointing at nothing is not a list.`);
    process.exit(1);
  }
for (const f of NEEDS.keys())
  if (!files.includes(f)) {
    console.error(
      `✖ python: NEEDS declares ${f}, which no longer exists. Remove the entry in the same change — a reason that outlived its subject reads as permission.`,
    );
    process.exit(1);
  }
if (tests.length === 0) {
  console.error(
    `✖ python: ${files.length} .py file(s) and no test_*.py among them. This gate exists because that state\n  let the file deciding what the exam is be fixed five times with nothing able to reach the decision.`,
  );
  process.exit(1);
}

// `python3` missing is a FAILURE. "Cannot find out" is an escalation, never a pass (rule `protocol` L2).
if (spawnSync("python3", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error("✖ python: python3 is not runnable here, so NOTHING was checked. That is a failure, not a skip.");
  process.exit(1);
}

const violations = [];
const unrun = [];
// `py_compile` writes bytecode; point it at a throwaway so a gate run never dirties the tree.
const cache = mkdtempSync(path.join(tmpdir(), "everdict-pycache-"));
try {
  const compiled = spawnSync("python3", ["-m", "py_compile", ...files], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONPYCACHEPREFIX: cache },
    maxBuffer: 1 << 26,
  });
  if (compiled.status !== 0) violations.push(`py_compile failed:\n${(compiled.stderr ?? "").trim()}`);

  for (const test of tests) {
    const res = spawnSync("python3", [path.join(root, test)], {
      cwd: path.dirname(path.join(root, test)),
      encoding: "utf8",
      env: { ...process.env, PYTHONPYCACHEPREFIX: cache, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 120_000,
      maxBuffer: 1 << 26,
    });
    if (res.error?.code === "ETIMEDOUT") {
      violations.push(`${test}: timed out after 120s. A test that cannot finish has not run.`);
      continue;
    }
    const output = [res.stdout, res.stderr].join("");
    if (res.status !== 0) {
      const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(output)?.[1];
      // A declared gap, failing for exactly the declared reason. Anything else from the same file is real.
      if (missing !== undefined && NEEDS.get(test) === missing) {
        unrun.push(`${test} (needs ${missing})`);
        continue;
      }
      if (missing !== undefined && !NEEDS.has(test)) {
        violations.push(
          `${test}: needs \`${missing}\`, which this gate does not install, and it is not declared in NEEDS. Either make it standard-library-only, or declare it with what it needs — an undeclared unrunnable test is one nobody knows is not running.`,
        );
        continue;
      }
      violations.push(`${test} exited ${res.status}:\n${output.trim()}`);
      continue;
    }
    // A test that runs and says nothing is indistinguishable from one that asserted nothing.
    if (!/\bPASS\b/.test(res.stdout ?? ""))
      violations.push(
        `${test} exited 0 and printed no PASS line. A silent green is not evidence — say what was checked.`,
      );
  }
} finally {
  rmSync(cache, { recursive: true, force: true });
}

if (violations.length > 0) {
  console.error(`\n✖ python: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}\n`);
  process.exit(1);
}
if (unrun.length > 0) {
  console.log(
    `· ${unrun.length} declared-unrunnable test file(s), each missing a dependency this gate does not install:`,
  );
  for (const u of unrun) console.log(`    ${u}`);
  console.log("  Closing them is `pip install pytest httpx` plus an editable install, in CI and locally — a");
  console.log("  maintainer's decision about machines and minutes, recorded here so it stays askable.");
}
console.log(
  `PASS python: ${files.length} file(s) compile, ${tests.length - unrun.length} of ${tests.length} test file(s) ran and passed.`,
);
