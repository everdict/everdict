#!/usr/bin/env node
// The trust suite runner — docs/trust-certification.md.
//
// The suite certifies INVARIANTS, not features: "no failure becomes a normal number or a verdict". Each
// scenario lives in a `*.trust.test.ts` file next to its subject, gated on EVERDICT_TRUST_SUITE=1 so the
// push-gating `pnpm test` stays fast. This script is what the nightly runs.
//
// Its one non-obvious job: REFUSE TO CERTIFY A SUITE THAT DID NOT RUN. Every trust file skips itself when its
// infrastructure is absent — the right behavior for a developer running one scenario on a laptop, and a
// catastrophic default for a nightly, because "0 failures" out of "0 executed" would print PASS. So a skipped
// trust test is a FAILED certification here. A suite that certifies nothing must never look like a suite that
// certified everything.
//
// Usage:
//   EVERDICT_TRUST_DATABASE_URL=postgresql://… node scripts/trust/trust-suite.mjs
//   …/trust-suite.mjs apps/api/src/trust '!apps/api/src/trust/temporal-'   (a named SUBSET — see below)
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Outside the source tree on purpose: these are machine-readable intermediates this script reads back, and a
// build artifact inside the repo is one every repo-wide tool then has to be taught to ignore. The
// human-readable run is already on stdout (vitest's verbose reporter runs alongside the json one).
const reportDir = path.join(tmpdir(), "everdict-trust-report");

const DATABASE_URL = process.env.EVERDICT_TRUST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "✖ TRUST SUITE NOT RUN — no database.\n" +
      "  Set EVERDICT_TRUST_DATABASE_URL (or DATABASE_URL) to a Postgres the suite may migrate and write to.\n" +
      "  Refusing to run rather than skipping the Pg-backed scenarios and reporting green.",
  );
  process.exit(1);
}

// Find every trust file and attribute it to the workspace package that owns it, so a new scenario in a new
// package is picked up without editing this script.
function findTrustFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTrustFiles(full, out);
    else if (entry.name.endsWith(".trust.test.ts")) out.push(full);
  }
  return out;
}

function packageOf(file) {
  let dir = path.dirname(file);
  while (dir.startsWith(root)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) return { name: JSON.parse(readFileSync(manifest, "utf8")).name, dir };
    dir = path.dirname(dir);
  }
  throw new Error(`no package.json above ${file}`);
}

// ── THE SAME RUNNER, A NAMED SUBSET (arch-review 52, wave 7) ─────────────────────────────────────────
//
// The full suite boots Temporal and MinIO and takes tens of minutes, which is why it is nightly. A subset of
// it needs nothing but Postgres and finishes in a few — fast enough to be a REQUIRED check on every push
// (.github/workflows/trust-fast.yml). That subset runs through this script rather than through a bare
// `vitest run`, because the rule that makes a certification mean anything lives here: a scenario that did not
// run is a FAILED certification. A required check that quietly skipped its scenarios would be worse than no
// check at all — it would print the word the reviewer is looking for over an empty run.
//
// A positional argument is a repo-relative path PREFIX to include; one prefixed with `!` excludes. No
// arguments = the whole suite, exactly as the nightly has always run it.
const scopeArgs = process.argv.slice(2);
const includePrefixes = scopeArgs.filter((arg) => !arg.startsWith("!"));
const excludePrefixes = scopeArgs.filter((arg) => arg.startsWith("!")).map((arg) => arg.slice(1));
const scoped = scopeArgs.length > 0;
function inScope(file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (excludePrefixes.some((prefix) => rel.startsWith(prefix))) return false;
  return includePrefixes.length === 0 || includePrefixes.some((prefix) => rel.startsWith(prefix));
}

const byPackage = new Map();
for (const file of [...findTrustFiles(path.join(root, "packages")), ...findTrustFiles(path.join(root, "apps"))]) {
  if (!inScope(file)) continue;
  const pkg = packageOf(file);
  const entry = byPackage.get(pkg.name) ?? { dir: pkg.dir, files: [] };
  entry.files.push(path.relative(pkg.dir, file));
  byPackage.set(pkg.name, entry);
}

if (byPackage.size === 0) {
  console.error(
    `✖ TRUST SUITE NOT RUN — no *.trust.test.ts files ${scoped ? `matched the scope [${scopeArgs.join(" ")}]` : "found"}. The suite cannot certify an empty set.`,
  );
  process.exit(1);
}

console.log(
  `▶ trust suite${scoped ? ` [scope: ${scopeArgs.join(" ")}]` : ""} — ${byPackage.size} package(s), ${[...byPackage.values()].reduce((n, e) => n + e.files.length, 0)} file(s)\n`,
);

rmSync(reportDir, { recursive: true, force: true });
mkdirSync(reportDir, { recursive: true });

const env = { ...process.env, EVERDICT_TRUST_SUITE: "1", EVERDICT_TRUST_DATABASE_URL: DATABASE_URL };
/** @type {{name: string, status: "pass"|"fail"|"skipped"}[]} */
const scenarios = [];
let hardFailure = false;

for (const [name, entry] of byPackage) {
  const jsonPath = path.join(reportDir, `${name.replace(/[@/]/g, "_")}.json`);
  console.log(`▶ ${name}`);
  const res = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      // Trust files share one certification database and each opens it with migrate(); parallel test
      // files race the first-boot migration DDL (CREATE TABLE IF NOT EXISTS collides in pg_type —
      // 23505). Certification is about determinism, not speed: run files one at a time.
      "--no-file-parallelism",
      // Vitest's 5s default is a bench-speed assumption, and these scenarios drive a real Postgres through
      // migrate() + multi-statement fences. TRUST-64 takes ~3s alone and blew the default once the whole
      // `packages` scope had populated the same database ahead of it — a TIMING artefact reported in the
      // same shape as a broken invariant. A certification lane must not fail for being loaded, so the budget
      // is set here, once, for every trust run: still far below a genuine hang, which is what a timeout is
      // for. Raise it here rather than per-file, so no scenario can quietly buy itself more room.
      "--testTimeout=20000",
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile=${jsonPath}`,
      ...entry.files,
    ],
    { cwd: entry.dir, stdio: "inherit", env },
  );
  if (!existsSync(jsonPath)) {
    console.error(`✖ ${name} produced no report (exit ${res.status}) — treated as a failed certification.`);
    hardFailure = true;
    continue;
  }
  const report = JSON.parse(readFileSync(jsonPath, "utf8"));
  for (const suite of report.testResults ?? []) {
    for (const test of suite.assertionResults ?? []) {
      const title = test.fullName ?? test.title ?? "(unnamed)";
      // vitest reports a skipped test as "pending"/"skipped" — both are a scenario that certified NOTHING.
      const status = test.status === "passed" ? "pass" : test.status === "failed" ? "fail" : "skipped";
      scenarios.push({ name: title, status });
    }
  }
}

const failed = scenarios.filter((s) => s.status === "fail");
const skipped = scenarios.filter((s) => s.status === "skipped");
const passed = scenarios.filter((s) => s.status === "pass");
const certified = !hardFailure && failed.length === 0 && skipped.length === 0 && passed.length > 0;

const lines = [];
// The scope is in the HEADLINE, not a footnote: a green summary from a subset must never read as the full
// certification to whoever is scanning a check list.
lines.push(`# Everdict Trust Certification${scoped ? " — SUBSET" : ""}: ${certified ? "PASS" : "FAIL"}`);
if (scoped) lines.push(`- scope: \`${scopeArgs.join(" ")}\``);
lines.push("");
lines.push(`- executed: **${passed.length}**`);
if (failed.length > 0) lines.push(`- failed: **${failed.length}**`);
if (skipped.length > 0)
  lines.push(`- skipped (counts as FAIL — a scenario that did not run certified nothing): **${skipped.length}**`);
lines.push("");
if (failed.length > 0) {
  lines.push("## Failing scenarios");
  for (const s of failed) lines.push(`- ${s.name}`);
  lines.push("");
}
if (skipped.length > 0) {
  lines.push("## Skipped scenarios");
  for (const s of skipped) lines.push(`- ${s.name}`);
  lines.push("");
}
if (certified) {
  lines.push(
    scoped
      ? "Every trust scenario IN SCOPE ran against real infrastructure and held — this is the fast subset, not the full certification. The nightly runs the rest."
      : "Every trust scenario ran against real infrastructure and held.",
  );
  lines.push("What this certifies — and what it deliberately does not — is in `docs/trust-certification.md`.");
}

const summary = lines.join("\n");
console.log(`\n${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

process.exit(certified ? 0 : 1);
