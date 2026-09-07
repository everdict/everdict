#!/usr/bin/env node
// ── A SCANNER WHOSE VOCABULARY DIED KEEPS PASSING ────────────────────────────────────────────────
//
// `check-authz-optional.mjs` watched four names and two of them — `assertTeamVisible`,
// `assertEntityVisible` — had ZERO live call sites after `0212_drop_team_axis.sql` removed the ownership axis
// they belonged to. It reported `PASS … 1998 files` the whole time. That is worse than a dead check: it runs,
// it passes, it prints a file count, and its header goes on teaching a call the codebase can no longer
// compile.
//
// Nothing here could catch it. `pnpm docs-check` verifies the symbols `.claude/**` backticks against live
// source; a name held inside a scanner's own array is source code, not prose, and no check read it. It was
// found by accident, when an eval case written from that header tested a shape this codebase does not have.
//
// So every scanner declares its vocabulary, and the answer is COMPLETE rather than opt-in — a scanner that
// watches nothing says so in one line, because "the ones somebody remembered to annotate" is the coverage
// this check exists to stop believing in.
//
//     export const WATCHES = ["gate", "authorize"];     // names that must exist in live source
//     // watches: nothing — structural                   // or the marker, for a scanner that matches shapes
//
// ⚠️ IT PARSES, IT DOES NOT IMPORT. These are scripts, not modules: importing one RUNS it in whatever tree the
// checker is standing in. Rule `ci` records what that cost for `protocol-mutations`.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];
const fail = (message) => violations.push(message);

// This file is the one scanner with nothing to declare to itself.
const SELF = "check-scanner-watches.mjs";

const WATCHES_DECL = /export\s+const\s+WATCHES\s*=\s*\[([\s\S]*?)\]/;
const MARKER = /^\/\/\s*watches:\s*nothing\s*—/m;
const STRING = /"([^"]+)"|'([^']+)'/g;

// ── the live corpus, once ────────────────────────────────────────────────────────────────────────
// Non-test `packages/*/src` + `apps/*/src`, comments stripped. Comments are stripped because a name that
// survives only in a comment is exactly the state this check was written for — `assertEntityVisible`'s only
// remaining occurrence was inside one. A name surviving only inside a string literal is accepted; that is the
// known approximation, and distinguishing it would cost a parser.
const tracked = execFileSync("git", ["ls-files", "packages/*/src/**", "apps/*/src/**"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts") && !/\.(test|scenario)\.tsx?$/.test(f));
if (tracked.length === 0) {
  console.error("✖ scanner-watches: the live corpus is empty, so every name would read as dead. Refusing to report.");
  process.exit(1);
}
const live = tracked
  .map((f) => readFileSync(path.join(root, f), "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const occurs = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(live);

// ── every scanner ────────────────────────────────────────────────────────────────────────────────
const scanners = readdirSync(path.join(root, "scripts"))
  .filter((f) => f.startsWith("check-") && f.endsWith(".mjs") && f !== SELF)
  .sort();
if (scanners.length === 0) {
  console.error("✖ scanner-watches: found no scripts/check-*.mjs. Refusing to report over an empty corpus.");
  process.exit(1);
}

let declared = 0;
let watched = 0;
for (const file of scanners) {
  const src = readFileSync(path.join(root, "scripts", file), "utf8");
  const decl = WATCHES_DECL.exec(src);
  if (decl === null) {
    if (!MARKER.test(src)) {
      fail(
        `scripts/${file}: declares neither \`export const WATCHES = [...]\` nor the marker \`// watches: nothing — <why>\`. Say what vocabulary it watches, so a dead one can be found by reading rather than by accident.`,
      );
    }
    continue;
  }
  declared++;
  const names = [...decl[1].matchAll(STRING)].map((m) => m[1] ?? m[2]).filter(Boolean);
  if (names.length === 0) {
    fail(
      `scripts/${file}: \`WATCHES\` is empty. A scanner that watches nothing uses the marker, so the two states stay distinguishable.`,
    );
    continue;
  }
  for (const name of names) {
    watched++;
    if (!occurs(name)) {
      fail(
        `scripts/${file}: watches \`${name}\`, which occurs nowhere in live source outside comments. The scanner still runs and still passes while guarding a name nothing calls — remove it, or say which migration is bringing it back.`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✖ scanner-watches: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\n  A scanner with a dead watch list reads exactly like coverage. See .claude/rules/ci.md.");
  process.exit(1);
}
console.log(
  `PASS scanner watches: ${scanners.length} scanners state their vocabulary; ${watched} watched name(s) across ${declared} of them are live.`,
);
