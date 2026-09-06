#!/usr/bin/env node
// watches: nothing — reads package.json and a rule file; it names no live source symbol.
//
// ── A CONTROL THAT EXISTS AND IS NAMED NOWHERE ───────────────────────────────────────────────────
//
// `pnpm convention-harness` asks whether a rule still reaches live paths. `pnpm docs-check` asks whether the
// paths and symbols a rule NAMES exist. Neither asks the reverse: does every control that exists get named by
// anything?
//
// It cost a commit to notice. The round that fixed "the conventions do not know about the harness" shipped,
// and the very next control — `pnpm scan` — went out with `.claude/rules/ci.md`, `CLAUDE.md` and the docs
// index untouched, by the same author, in the same session. That round repaired every instance by hand and
// shipped no way to notice the next one, which is the exact criticism it made of prose laws.
// See `lessons/2026-09-05-a-control-shipped-and-the-conventions-did-not-know.md`.
//
// So: every `package.json` script that runs something under `scripts/` or `evals/` is a control, and rule
// `ci` must name it. An entry that is deliberately undocumented says why in DECLARED.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULE = path.join(root, ".claude", "rules", "ci.md");

// Scripts that run repository tooling but are not controls a reader needs the rule to explain. Each says why,
// and an entry whose script is gone FAILS: a reason that outlived its subject reads as permission.
const DECLARED = new Map([
  ["telemetry", "an opt-in collector, not a gate; its contract is scripts/telemetry/README.md"],
  ["triage", "explains a red gate rather than being one; named by the rule's watch-bands bullet"],
]);

const SKILLS_INDEX = path.join(root, ".claude", "skills", "README.md");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const rule = readFileSync(RULE, "utf8");

const controls = Object.entries(pkg.scripts ?? {})
  .filter(([, command]) => /(^|\s)node\s+(scripts|evals)\//.test(String(command)))
  .map(([name]) => name);

const violations = [];
if (controls.length === 0) {
  console.error("✖ controls-documented: found no controls in package.json. Refusing to report over an empty set.");
  process.exit(1);
}

for (const name of controls) {
  if (DECLARED.has(name)) continue;
  // Named, in any form the rule actually uses: `pnpm x`, **`pnpm x`**, or the bare script name in a list.
  if (!new RegExp(`pnpm ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(rule)) {
    violations.push(
      `package.json declares control \`${name}\` and .claude/rules/ci.md never names \`pnpm ${name}\`. A control the conventions do not mention is one a reader following them will not run.`,
    );
  }
}
for (const [name, why] of DECLARED) {
  if (!controls.includes(name)) {
    violations.push(
      `DECLARED names \`${name}\`, which is no longer a control in package.json (${why}). A reason that outlived its subject reads as permission.`,
    );
  }
}

// ── the other direction: every must-hold policy names an enforcer that EXISTS ─────────────────────
//
// `.claude/skills/README.md` pairs each must-always-hold policy with the gate or hook behind it, because a
// skill is advisory and the playbook says so. A row whose enforcer is gone is a policy that has quietly gone
// back to being advisory while the table still says otherwise — the same shape as a control the conventions
// never named, in the other direction. So the table is read: every `pnpm <x>` it names is a script in
// package.json, every `scripts/…` path it names is a file, and the table itself is not empty.
const index = readFileSync(SKILLS_INDEX, "utf8");
const tableStart = index.indexOf("| Policy | Taught by | Enforced by |");
if (tableStart < 0) {
  violations.push(
    ".claude/skills/README.md has no `| Policy | Taught by | Enforced by |` table — the pairing between policies and their enforcers is unrecorded.",
  );
} else {
  const rows = index
    .slice(tableStart)
    .split("\n")
    .slice(2) // header + separator
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").map((c) => c.trim()))
    .filter((cells) => cells.length >= 4);
  if (rows.length === 0) {
    violations.push(
      ".claude/skills/README.md's enforcement table has no rows. Refusing to report over an empty table.",
    );
  }
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  for (const cells of rows) {
    const [, policy, , enforcedBy] = cells;
    for (const m of enforcedBy.matchAll(/`pnpm ([a-z:-]+)`/g)) {
      if (!scripts.has(m[1])) {
        violations.push(
          `.claude/skills/README.md pairs "${policy}" with \`pnpm ${m[1]}\`, which is not a script in package.json. The policy is advisory again and the table says it is not.`,
        );
      }
    }
    for (const m of enforcedBy.matchAll(/`(scripts\/[^`]+\.mjs)`/g)) {
      if (!existsSync(path.join(root, m[1]))) {
        violations.push(
          `.claude/skills/README.md pairs "${policy}" with \`${m[1]}\`, which does not exist in the tree.`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✖ controls-documented: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\n  A round that repairs every instance and ships no way to detect the next one bought a repair,\n  not a rule. See lessons/2026-09-05-a-control-shipped-and-the-conventions-did-not-know.md.",
  );
  process.exit(1);
}
console.log(
  `PASS controls documented: ${controls.length} control(s) in package.json, all named by rule \`ci\` (${DECLARED.size} declared otherwise).`,
);
