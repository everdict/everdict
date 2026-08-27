#!/usr/bin/env node
// ── A COMMIT MAY NOT CARRY A NEUTRALIZED PROTOCOL (arch-review 112) ─────────────────────────────────
//
// `pnpm protocol-mutations` writes one neutralization at a time into a production file and reverts it in a
// `finally`. Rule `ci` already warns that a killed run leaves its in-flight mutation in the tree; what it does
// not cover is the run that is alive and WORKING while somebody commits beside it. The gate's own guard —
// refusing to start on a dirty worktree — protects the gate, not the author: between two rungs the tree is
// clean, and while a rung is in flight it is dirty in a file the author never opened.
//
// That is how `cdef2c2a` shipped `const state = "written" as const; void evaluateRef;` — the arch-review 70 P1
// defect, put back — in a commit about something else entirely. It took a history rewrite of two commits to
// remove, because `pnpm ci:commits` runs lint+typecheck+test on EVERY commit ahead of the remote and a rung
// exists precisely so that its suite goes red: the batch was unpushable until the leak was gone.
//
// `ci:commits` would have caught it, eventually, slowly. This is the same question asked in two seconds, from
// the text the rungs already declare, so the answer arrives while the author still remembers what they staged.
//
// It compares each commit's ADDED lines against every rung's `to:` replacement. The rung definition file is
// excluded by construction — it is where those strings legitimately live — and short replacements (`false`,
// `undefined`) are skipped because they are ordinary code, not a fingerprint.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const RUNGS = "scripts/trust/protocol-mutations.mjs";
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

// The upstream this batch is measured against. A repository with no remote-tracking branch has no "unpushed",
// so there is nothing to check and that is a pass, not an error.
let base;
try {
  base = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).trim();
} catch {
  console.log("PASS mutation leak: no upstream branch — nothing is pending.");
  process.exit(0);
}

const source = readFileSync(`${ROOT}/${RUNGS}`, "utf8");

// Two `to:` FORMS, because the rungs use two. A single-line replacement is a quoted string; a multi-line one is
// sometimes an array of quoted lines `.join("\n")`, and reading only the first form left two rungs — both K8s
// adoption, both several lines long — with no fingerprint at all. A scanner that silently covers 234 of 236
// reports the same "PASS" as one that covers all of them, which is why the two counts are printed below: an
// author who adds a third form sees the total stop matching the file.
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const unquote = (literal) =>
  literal.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");

const declared = (source.match(/^\s*to:/gm) ?? []).length;
const single = [...source.matchAll(new RegExp(String.raw`^\s*to:\s*(${QUOTED})\s*,`, "gm"))].map((m) => unquote(m[1]));
// ⚠️ `\\n` — TWO characters in the SOURCE being scanned (`.join("\\n")`), not a newline. `biome check --write`
// rewrote an earlier `String.raw` spelling of this regex into a literal and dropped one backslash, which broke
// the extractor into matching nothing; the commit shipped because a formatter run was treated as evidence. It
// was caught one command later by the coverage counter above — which is the argument for the counter.
const joined = [...source.matchAll(/^\s*to:\s*\[([\s\S]*?)\]\.join\("\\n"\)/gm)].map((m) =>
  [...m[1].matchAll(new RegExp(QUOTED, "g"))].map((q) => unquote(q[0])).join("\n"),
);

const replacements = [...single, ...joined]
  .map((text) => text.trim())
  // A fingerprint has to be long enough to mean something. `to: "false"` is a rung too, and matching it would
  // flag every commit that writes the word — a check that cries wolf is one nobody reads (rule `ci`).
  .filter((text) => text.length > 18);

if (single.length + joined.length < declared) {
  console.error(
    `✖ ${declared - single.length - joined.length} of ${declared} rung replacement(s) are in a form this check`,
  );
  console.error("  cannot read, so a commit could carry one invisibly. Teach the extractor the new form.");
  process.exit(1);
}

const commits = git(["log", "--format=%h", `${base}..HEAD`])
  .trim()
  .split("\n")
  .filter(Boolean);
const leaks = [];
for (const commit of commits) {
  const diff = git(["show", "--format=", "-U0", commit, "--", ".", `:(exclude)${RUNGS}`]);
  // ⚠️ THE `+` COMES OFF. A rung's replacement is often SEVERAL lines (`\n` inside the `to:` string), and a
  // diff prefixes every one of them — so joining the raw lines means a multi-line neutralization can never
  // match, and the check passes over exactly the rungs whose fingerprint is most distinctive. The first draft
  // of this file did that and reported the real incident (`cdef2c2a`, a two-line replacement) as CLEAN. Found
  // by driving it against that commit rather than by reading it, which is the only way this class is ever found.
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  for (const text of replacements) if (added.includes(text)) leaks.push({ commit, text });
}

if (leaks.length > 0) {
  console.error("✖ commit(s) carrying a protocol neutralization:\n");
  for (const { commit, text } of leaks) console.error(`  ${commit}  ${text.split("\n")[0].slice(0, 90)}`);
  console.error("\n  This is `pnpm protocol-mutations` writing into the tree while you staged beside it. The");
  console.error("  protocol is DISABLED in that commit and its rung's suite would go red on it.");
  console.error("  Restore the file from the commit's parent and rewrite the affected commits — a later commit");
  console.error("  that puts the line back still leaves one commit in the batch shipping the defect.");
  process.exit(1);
}
console.log(
  `PASS mutation leak: ${commits.length} commit(s) ahead of ${base} carry none of ${replacements.length} neutralizations.`,
);
