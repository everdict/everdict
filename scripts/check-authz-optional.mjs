#!/usr/bin/env node
// ── AN AUTHORIZATION INPUT MAY NOT BE OPTIONAL-CHAINED — CHECKED (arch-review 79) ───────────────────
//
// In an authorization call, `undefined` is the PERMISSIVE arm — nothing to check, so the decision is made on
// less than it was meant to be made on. Optional chaining produces `undefined` for reasons that have nothing
// to do with the resource: a service this deployment did not wire, a row that is not there, a field the type
// says may be missing. Every one of them silently widens the check.
//
//     const principal = await deps.authService?.resolve(req);
//     authorize(principal?.roles, "issues:write");        // ← absent service = allowed
//
// The fix at a flagged site is one of two things, never a third:
//   · refuse when the capability is absent (`if (!deps.x) return 404`), so the authz input is unambiguous;
//   · resolve the value first and narrow it (`if (row === undefined) return 404`), then pass it plainly.
//
// This is written as a scanner rather than as a rule because the prose version failed THREE TIMES IN TWO
// HOURS, all by its own author. The mechanism is not forgetfulness: the dependency's type is
// `issueService?: IssueService`, so the plain `.get` does not compile — and the shortest path from that
// compile error is to add `?.`, not to refuse. The optional type makes the unsafe spelling the one that
// builds, which is exactly the shape rule `protocol` calls "invisible at the site where it is committed".
//
// ⚠️ HISTORY, NOT INSTRUCTION. The three incidents that produced this check were all about a TEAM axis —
// `deps.campaignService?.get(...)` feeding `assertTeamVisible`, then `deps.issueService?.get(...)`, then
// `issue?.teamId` handed straight to `gate`. That axis is GONE: `0212_drop_team_axis.sql` removed it, `gate`
// takes `(principal, action)` and no resource-derived argument, and `assertTeamVisible` /
// `assertEntityVisible` have zero live call sites. They were watched here long after they stopped existing,
// and the check went on reporting PASS over 1998 files while half its watch list named nothing — which is why
// `pnpm scanner-watches` exists. The law did not narrow when the axis went; only its worked example did.
// Reintroducing a resource-scoped authorization argument means re-adding its name to WATCHES in the same
// change.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

// The calls that DECIDE. Both throw on deny, and both read `undefined` as "nothing to check". Exported so
// `pnpm scanner-watches` can refuse a name that has stopped existing — the failure this list already had.
export const WATCHES = ["gate", "authorize"];
const AUTHZ = WATCHES;

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
