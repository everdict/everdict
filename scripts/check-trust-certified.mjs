#!/usr/bin/env node
// `pnpm trust-certified` — how many trust scenarios this push has NOT certified, and when anything last did.
//
// ── THE INCIDENT ─────────────────────────────────────────────────────────────────────────────────────
//
// A change made `sanitizeScore` stamp a structured identity on every score. Five trust scenarios assert a
// whole `Score` with `toEqual`, so they went red on the new key; a sixth digested a raw literal into a commit
// receipt while the store persisted the sanitized document, so the receipt named bytes the row would never
// hold. All six shipped, and stayed red for days.
//
// Nothing here could see it, and not by accident: `*.trust.test.ts` gates on `EVERDICT_TRUST_SUITE === "1"`,
// so `pnpm test` reports them SKIPPED and exits 0, `pnpm ci:local` boots no Postgres/MinIO/ClickHouse by
// design, and `pnpm ci:commits` skips them once per commit. The one thing that runs them is the `trust-fast`
// workflow, and every workflow in this repository has been `disabled_manually` since 2026-08-21
// (`docs/architecture/harness-declared-limits.md` C3). `.claude/rules/ci.md` has carried the warning — *"a
// trust scenario that SKIPS is not a passing one, and locally that is the default"* — the whole time, and
// prose is what it was. See `lessons/2026-09-10-five-certifications-went-red-and-pnpm-test-said-green.md`.
//
// ── WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────────────────────
//
// It does NOT run them. Booting three containers inside the push gate is the cost the maintainer chose not to
// pay, and a gate that needs infrastructure it cannot start teaches people to bypass gates.
//
// It also does NOT fail. Same reason: `ci:local` cannot certify these, so refusing the push would make the
// only available move a bypass. What it refuses is that **skipped and passed look alike** in the summary a
// person actually reads. It prints the count, the last certification's sha and date, and — the number that
// matters — which files in the certified scope have CHANGED since, because those are the scenarios standing
// on evidence that no longer describes them.
//
// ⚠️ It IS red on one thing: a scope that has drifted from the workflow's own invocation. The count is
// meaningless if this file and the command a person runs disagree about what "in scope" means, and that
// is exactly the silent kind — so the scope is read OUT of the workflow rather than copied beside it.
//
// watches: nothing — it reads paths and a marker file, not source vocabulary.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();

// ── THE SCOPE IS `pnpm trust-fast`'S OWN, READ RATHER THAN RESTATED ──────────────────────────────────
//
// It used to be parsed out of `.github/workflows/trust-fast.yml`, which was the SSOT while a workflow ran it.
// The workflows were DELETED on 2026-09-11 (declared-limits C3 — remote CI is not merely off, it is gone, and
// the trust suite is run locally when it is needed), so the scope moved to the command a person actually
// types. Same discipline either way: a second copy here would drift the way every second copy in this
// repository has drifted (rule `protocol` L3), and it would drift SILENTLY — the count below would go on
// looking authoritative while describing a different population.
const PACKAGE_JSON = path.join(root, "package.json");
const TRUST_FAST = "trust-fast";
const RUNNER = "node scripts/trust/trust-suite.mjs";
let invocation;
try {
  invocation = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).scripts?.[TRUST_FAST];
} catch (err) {
  console.error(`✖ trust-certified: package.json could not be read (${err instanceof Error ? err.message : err}).`);
  process.exit(1);
}
if (typeof invocation !== "string" || !invocation.startsWith(RUNNER)) {
  console.error(
    `✖ trust-certified: package.json has no \`${TRUST_FAST}\` script invoking ${RUNNER} — the scope has no source.
  That script IS the required subset's definition now that no workflow carries it; restore it rather than
  copying a scope in here.`,
  );
  process.exit(1);
}
// Whitespace-separated arguments after the runner. The quotes are the shell's (a leading `!` is a pathspec
// negation, quoted so no shell eats it) and are stripped.
const scope = invocation
  .slice(RUNNER.length)
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((arg) => arg.replace(/^'|'$/g, ""));
const include = scope.filter((a) => !a.startsWith("!"));
const exclude = scope.filter((a) => a.startsWith("!")).map((a) => a.slice(1));
if (include.length === 0) {
  console.error(`✖ trust-certified: parsed no scope out of package.json's \`${TRUST_FAST}\` script.`);
  process.exit(1);
}

// ── THE CORPUS ───────────────────────────────────────────────────────────────────────────────────────
//
// An empty corpus is not a pass (CLAUDE.md): a counter with nothing to count reads exactly like coverage.
const files = git("ls-files", "*.trust.test.ts")
  .split("\n")
  .filter(Boolean)
  .filter((f) => include.some((p) => f.startsWith(p)) && !exclude.some((p) => f.startsWith(p)));
if (files.length === 0) {
  console.error(
    `✖ trust-certified: no *.trust.test.ts matched the workflow's scope (${scope.join(" ")}).
  Refusing to report over an empty corpus — nothing to count is not nothing to certify.`,
  );
  process.exit(1);
}

const gitDir = git("rev-parse", "--absolute-git-dir");
const commonDir = path.resolve(root, git("rev-parse", "--git-common-dir"));
const marker = [gitDir, commonDir].map((d) => path.join(d, "everdict-trust-ok")).find((f) => existsSync(f));

console.log("▶ trust certification — NOT run here (three containers; declared-limits C3)");
console.log(`  ${files.length} scenario file(s) in the required check's scope: ${scope.join(" ")}`);

const RECIPE =
  "  run it: docs/trust-certification.md, or `.claude/rules/ci.md`'s EVERDICT_TRUST_* recipe against throwaway containers.";

if (!marker) {
  console.log(
    `  ✖ NEVER certified from this checkout. Those ${files.length} file(s) have run here zero times, and
    \`pnpm test\` reports every one of them as SKIPPED, which is not the same as passing.`,
  );
  console.log(RECIPE);
  process.exit(0);
}

const [sha, at, executed, ...certifiedScope] = readFileSync(marker, "utf8").trim().split(/\s+/);
const days = at ? Math.floor((Date.now() - Date.parse(at)) / 86_400_000) : undefined;
// ANCESTOR, not merely present. `cat-file -e` answers yes for an object the repository still holds and no
// ref reaches — which is every commit a history rewrite orphaned, and this session rewrote its own twice.
// A certification of a commit this branch does not descend from says nothing about this tree; same predicate
// `scripts/review/run.mjs` uses to decide whether a stamp may be resumed from.
const known =
  sha !== undefined && spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root }).status === 0;
console.log(
  `  last certified ${sha ? sha.slice(0, 9) : "?"} on ${at?.slice(0, 10) ?? "?"}` +
    `${days === undefined ? "" : ` (${days}d ago)`} — ${executed ?? "?"} scenario(s) executed, 0 failed`,
);
if (!known) {
  console.log("  ⚠ that commit is not in this history (a rewrite, or another repository) — treat it as none.");
  console.log(RECIPE);
  process.exit(0);
}

// ── THE MARKER'S SCOPE IS A CLAIM, AND IT IS THE CLAIM THIS SCRIPT EXISTS TO CHECK ───────────────────
//
// `trust-suite.mjs` takes a scope, and its own header documents running a NAMED SUBSET — which is exactly
// what a person debugging one lane does. That run passes, writes the marker, and until this block existed the
// reader below compared only the sha: a certification of `apps/api/src/trust` alone printed "nothing in the
// certified scope has changed since" while every `packages/**` and `apps/agent/**` scenario had never run at
// that commit. A partial certification reading as a full one is the incident this whole script is about,
// reproduced by the script itself (found by `pnpm review`).
//
// Coverage, not equality: a BROADER certification still covers the required scope, and refusing it would
// refuse the full nightly. What is reported is a required include the marker does not carry, and an exclude
// the marker applied that the required scope does not — both are ways the run looked at less than this
// claims.
const certifiedIncludes = certifiedScope.filter((a) => !a.startsWith("!"));
const certifiedExcludes = certifiedScope.filter((a) => a.startsWith("!")).map((a) => a.slice(1));
const uncovered = include.filter((p) => !certifiedIncludes.some((c) => p === c || p.startsWith(`${c}/`)));
const overExcluded = certifiedExcludes.filter((c) => !exclude.some((e) => c === e || c.startsWith(e)));
if (certifiedScope.length === 0) {
  console.log(
    `  ⚠ the marker records no scope, so what it certified cannot be established — treat it as none.
    (A marker written before this field existed. Re-run the suite to replace it.)`,
  );
  console.log(RECIPE);
  process.exit(0);
}
if (uncovered.length > 0 || overExcluded.length > 0) {
  console.log(
    `  ✖ that run certified a NARROWER scope than the required check's: \`${certifiedScope.join(" ")}\`.
    Never run at that commit: ${[...uncovered, ...overExcluded.map((e) => `!${e}`)].join(" ")}
    A partial certification reading as a full one is the thing this check exists to refuse.`,
  );
  console.log(RECIPE);
  process.exit(0);
}

// The number that matters. A certification is a statement about a TREE; every file in scope that has moved
// since is a scenario standing on evidence that no longer describes it.
const changed = git("diff", "--name-only", sha, "HEAD", "--", ...include)
  .split("\n")
  .filter(Boolean)
  .filter((f) => !exclude.some((p) => f.startsWith(p)));
if (changed.length === 0) {
  console.log(
    "  ✓ the full required scope was certified and nothing in it has changed since — every scenario still describes this tree.",
  );
  process.exit(0);
}
const changedScenarios = changed.filter((f) => f.endsWith(".trust.test.ts"));
console.log(
  `  ⚠ ${changed.length} file(s) in scope have changed since, ${changedScenarios.length} of them scenarios —
    UNCERTIFIED at HEAD. This is advisory on purpose; it is not advisory about whether they ran.`,
);
for (const f of changed.slice(0, 12)) console.log(`      ${f}`);
if (changed.length > 12) console.log(`      … and ${changed.length - 12} more`);
console.log(RECIPE);
