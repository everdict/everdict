#!/usr/bin/env node
// ── AN AUTHORIZATION INPUT MAY NOT BE OPTIONAL-CHAINED — CHECKED (arch-review 79) ───────────────────
//
// In an authorization call, `undefined` is the PERMISSIVE arm: no team constraint, so the workspace-level
// action decides alone. Optional chaining produces `undefined` for reasons that have nothing to do with the
// resource — a service this deployment did not wire, a row that is not there, a field the type says may be
// missing — and every one of them silently widens the check.
//
//     const campaign = await deps.campaignService?.get(...);
//     await assertTeamVisible(deps, principal, campaign?.teamId, "Campaign");   // ← absent service = allowed
//
// This is written as a scanner rather than as a rule because the prose version failed THREE TIMES IN TWO
// HOURS, all by its own author:
//
//     78   `deps.campaignService?.get(...)` in the security fix that added the team gate
//     79   `deps.issueService?.get(...)` in the fix FOR that, both transports
//     79   `issue?.teamId` handed straight to `gate` in the fix for THAT
//
// The mechanism is not forgetfulness. The dependency's type is `issueService?: IssueService`, so the plain
// `.get` does not compile — and the shortest path from that compile error is to add `?.`, not to refuse. The
// optional type makes the unsafe spelling the one that builds, which is exactly the shape rule `protocol`
// calls "invisible at the site where it is committed".
//
// The fix at a flagged site is one of two things, never a third:
//   · refuse when the capability is absent (`if (!deps.x) return 404`), so the authz input is unambiguous;
//   · resolve the value first and narrow it (`if (row === undefined) return 404`), then pass it plainly.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

// The calls that DECIDE. `gate`/`authorize` throw on deny; `assertTeamVisible`/`assertEntityVisible` answer
// 404 for a resource this caller may not see. All four read `undefined` as "nothing to check".
const AUTHZ = ["gate", "authorize", "assertTeamVisible", "assertEntityVisible"];

// Sites where an absent value is the SUBJECT of the assertion rather than an input to it — i.e. the code is
// deliberately proving that an unowned resource is allowed. Each entry says why, and an entry whose site
// stopped optional-chaining FAILS: a reason that outlived its subject reads as permission.
const DECLARED = new Map([]);

const tracked = execFileSync("git", ["ls-files", "apps/**/*.ts", "packages/**/*.ts"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f !== "" && !f.endsWith(".d.ts") && !/\.(test|scenario)\.ts$/.test(f) && !f.includes("/dist/"));

const findings = [];
const seen = new Set();

for (const file of tracked) {
  const src = readFileSync(`${ROOT}/${file}`, "utf8");
  if (!AUTHZ.some((fn) => src.includes(`${fn}(`))) continue;
  const lines = src.split("\n");
  for (const [i, line] of lines.entries()) {
    const code = line.replace(/\/\/.*$/, ""); // a comment quoting the pattern is not a call site
    for (const fn of AUTHZ) {
      const at = code.indexOf(`${fn}(`);
      if (at === -1) continue;
      // The call's arguments, up to the balancing paren on this line (an authz call spanning lines with an
      // optional chain in a later argument is rare enough to catch on the next widening, and a scanner that
      // guesses across lines is one people learn to skip).
      const args = code.slice(at + fn.length + 1);
      if (!/\?\./.test(args)) continue;
      const key = `${file}:${i + 1}`;
      if (DECLARED.has(key) || seen.has(key)) continue;
      seen.add(key);
      findings.push({ key, fn, line: line.trim() });
    }
  }
}

for (const [key, reason] of DECLARED)
  if (!seen.has(key)) findings.push({ key, fn: "DECLARED", line: `stale allowlist entry (${reason})` });

if (findings.length > 0) {
  console.error("✖ authorization inputs must not be optional-chained:\n");
  for (const f of findings) console.error(`  ${f.key}  ${f.fn}\n    ${f.line}`);
  console.error(
    "\n  `undefined` is the PERMISSIVE arm of an authz check. Refuse when the capability is absent, or narrow",
  );
  console.error("  the value before passing it — never hand authorization a maybe.");
  process.exit(1);
}
console.log(
  `PASS authz optional-chaining: ${tracked.length} files, no authorization decision reads a maybe (${DECLARED.size} declared).`,
);
