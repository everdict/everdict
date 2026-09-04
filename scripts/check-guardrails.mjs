#!/usr/bin/env node
// ── THE GATE THAT GUARDS EVERYTHING ELSE WAS GUARDED BY A SENTENCE ───────────────────────────────
//
// `scripts/hooks/pre-push-gate.mjs` is the enforcement layer for both ledgers — CI parity, and since this
// week the agent evals. It is wired in `.claude/settings.json`, an editable file in the tree, and until this
// check nothing read that wiring: `grep -l settings.json scripts/check-*.mjs` returned nothing. What stood in
// for a check was a line in CLAUDE.md — "Never work around it (no stamp forging, no pushing outside the
// tool)" — which is prose, in a repository that has recorded a dozen times what happens to a law kept as
// prose. Deleting the hook block is a two-line edit every other gate stays green through, and the next push
// is ungated with nothing saying so.
//
// Two halves, and only together:
//   · the WIRING still exists (a textual question, and the only one that catches a deletion);
//   · the DECISION still decides (a behavioural question, driven over a truth table).
// A check that only read the text would certify spelling. A check that only drove the function would pass on
// a tree where nothing calls it.
//
// Reads SOURCE only (no build, no deps, no git), prints every violation, exits 1.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, CONFIG_PATHS, decideGate } from "./hooks/gate-decision.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];
const fail = (message) => violations.push(message);

// ── half one: the wiring ─────────────────────────────────────────────────────────────────────────
const HOOK = "scripts/hooks/pre-push-gate.mjs";
const settingsPath = path.join(root, ".claude", "settings.json");
if (!existsSync(settingsPath)) {
  fail(".claude/settings.json is missing — the push gate is not wired into anything.");
} else {
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (err) {
    fail(
      `.claude/settings.json is not readable as JSON (${err.message}) — an unparseable settings file wires no hooks.`,
    );
  }
  const preToolUse = settings?.hooks?.PreToolUse;
  if (!Array.isArray(preToolUse) || preToolUse.length === 0) {
    fail(".claude/settings.json declares no PreToolUse hooks — nothing stops an ungated push.");
  } else {
    const commands = preToolUse.flatMap((entry) => (entry?.hooks ?? []).map((h) => String(h?.command ?? "")));
    if (!commands.some((c) => c.includes("pre-push-gate.mjs"))) {
      fail(
        `.claude/settings.json has PreToolUse hooks but none runs ${HOOK} — the gate is present in the tree and wired to nothing.`,
      );
    }
    const matchers = preToolUse.map((entry) => String(entry?.matcher ?? ""));
    if (!matchers.some((m) => m === "Bash" || m === "*")) {
      fail(
        `.claude/settings.json wires ${HOOK} under matcher(s) ${matchers.join(", ") || "(none)"} — a push is a Bash call, so a narrower matcher never fires.`,
      );
    }
  }
}
if (!existsSync(path.join(root, HOOK))) {
  fail(`${HOOK} does not exist.`);
} else {
  const hook = readFileSync(path.join(root, HOOK), "utf8");
  if (!hook.includes("decideGate")) {
    fail(`${HOOK} no longer consumes decideGate — the decision this check drives is not the one the hook makes.`);
  }
  // A recording added and then guarded by nothing is the same class of thing as the gate wiring that nothing
  // read until it was checked: it regresses silently, and the first sign is an empty ledger nobody queried.
  if (!hook.includes("everdict-gate-log.jsonl")) {
    fail(`${HOOK} no longer writes the decision ledger — the gate would decide constantly and remember nothing.`);
  }
}

// ── half two: the decision ───────────────────────────────────────────────────────────────────────
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const full = new Map([[HEAD, "full"]]);

/** [name, facts, expected, arm] */
const TABLE = [
  [
    "an unreadable CI ledger is a DENY, not an empty one",
    { head: HEAD, pushed: [HEAD], ciLedger: null, evalLedger: [], configChanged: false },
    "deny",
    ARMS.CI_LEDGER_UNREADABLE,
  ],
  [
    "a tip with no FULL stamp is refused",
    { head: HEAD, pushed: [HEAD], ciLedger: new Map([[HEAD, "fast"]]), evalLedger: null, configChanged: false },
    "deny",
    ARMS.TIP_UNSTAMPED,
  ],
  [
    "an ungated intermediate commit is refused even when the tip is full",
    { head: HEAD, pushed: [HEAD, OTHER], ciLedger: full, evalLedger: null, configChanged: false },
    "deny",
    ARMS.COMMITS_UNSTAMPED,
  ],
  [
    "a configuration change with no eval ledger is refused",
    { head: HEAD, pushed: [HEAD], ciLedger: full, evalLedger: null, configChanged: true },
    "deny",
    ARMS.EVAL_LEDGER_UNREADABLE,
  ],
  [
    "a configuration change stamped for another commit is refused",
    { head: HEAD, pushed: [HEAD], ciLedger: full, evalLedger: [OTHER], configChanged: true },
    "deny",
    ARMS.EVAL_STAMP_MISMATCH,
  ],
  [
    "a configuration change stamped for HEAD is allowed",
    { head: HEAD, pushed: [HEAD], ciLedger: full, evalLedger: [`${HEAD} `], configChanged: true },
    "allow",
    ARMS.ALLOW,
  ],
  [
    "a push that changes no configuration never meets the eval arm",
    { head: HEAD, pushed: [HEAD], ciLedger: full, evalLedger: null, configChanged: false },
    "allow",
    ARMS.ALLOW,
  ],
];

for (const [name, facts, expected, arm] of TABLE) {
  const decision = decideGate(facts);
  const actual = decision.allow ? "allow" : "deny";
  if (actual !== expected) {
    fail(`decision: ${name} — expected ${expected}, got ${actual}${decision.allow ? "" : ` (${decision.reason})`}`);
    continue;
  }
  // The ARM, not the prose: it is what the decision ledger records and what a query over a thousand denials
  // counts, so a reworded reason must not be able to change what this check certified.
  if (decision.arm !== arm) {
    fail(
      `decision: ${name} — expected arm \`${arm}\`, got \`${decision.arm}\`. The ledger would file this denial under the wrong control.`,
    );
  }
  if (!decision.allow && decision.reason.length < 20) {
    fail(`decision: ${name} — denied with no usable reason, so the person it stops learns nothing.`);
  }
}

if (CONFIG_PATHS.length === 0) {
  fail("gate-decision.mjs declares no CONFIG_PATHS — the eval arm can never fire.");
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error(`\n✖ guardrails: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\n  The push gate is what every other gate is enforced BY. See .claude/rules/ci.md.");
  process.exit(1);
}
console.log(`PASS guardrails: the push gate is wired, and its decision holds over ${TABLE.length} cases.`);
