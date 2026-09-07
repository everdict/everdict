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
// Four halves, and only together:
//   · the WIRING still exists (a textual question, and the only one that catches a deletion);
//   · the DECISION still decides (a behavioural question, driven over a truth table);
//   · the SCOPE still reaches every checkout that shares this `.git` (driven against a REAL linked worktree,
//     because the 2026-09-06 audit found a push from one exiting the hook silently — the scope compared
//     toplevels, and a linked worktree has its own);
//   · the WATCHER still refuses in dry-run at 3σ (driven over a fixture series, because the gate calls it
//     dry-run, and a dry-run that exits 0 on a breach is a rehearsal the push never waits for).
// A check that only read the text would certify spelling. A check that only drove the function would pass on
// a tree where nothing calls it. A check that only drove the function would also have passed on the tree
// with the side door, because the door was in the facts the function never saw.
//
// Reads SOURCE and creates one throwaway linked worktree (no build, no deps), prints every violation, exits 1.
// watches: nothing — drives the gate decision; the identifiers it uses are its own, not live source's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, CONFIG_PATHS, decideGate } from "./hooks/gate-decision.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];
const fail = (message) => violations.push(message);

// ── half one: the wiring ─────────────────────────────────────────────────────────────────────────
const HOOK = "scripts/hooks/pre-push-gate.mjs";
const SINK_HOOK = "scripts/telemetry/ensure-sink.mjs";
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
    // The probe mode decides nothing and records nothing. It exists for THIS check; a settings file that
    // wires it as the hook has wired a gate that never denies.
    if (commands.some((c) => c.includes("pre-push-gate.mjs") && c.includes("--probe"))) {
      fail(`.claude/settings.json wires ${HOOK} with --probe — the probe never denies and never records.`);
    }
    const matchers = preToolUse.map((entry) => String(entry?.matcher ?? ""));
    if (!matchers.some((m) => m === "Bash" || m === "*")) {
      fail(
        `.claude/settings.json wires ${HOOK} under matcher(s) ${matchers.join(", ") || "(none)"} — a push is a Bash call, so a narrower matcher never fires.`,
      );
    }
  }
  // The collector. Three indicators exist only while something listens on the OTLP port, and until the
  // SessionStart hook they were collected when somebody remembered a second terminal — the ledger held two
  // probe lines from the day it was written. Unwiring this is silent in exactly the way unwiring the gate was.
  const sessionStart = settings?.hooks?.SessionStart;
  const startCommands = Array.isArray(sessionStart)
    ? sessionStart.flatMap((entry) => (entry?.hooks ?? []).map((h) => String(h?.command ?? "")))
    : [];
  if (!startCommands.some((c) => c.includes("ensure-sink.mjs"))) {
    fail(
      `.claude/settings.json has no SessionStart hook running ${SINK_HOOK} — nothing starts the telemetry collector, so the session indicators go back to being emitted into nothing.`,
    );
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
if (!existsSync(path.join(root, SINK_HOOK))) fail(`${SINK_HOOK} does not exist.`);

// ── half two: the decision ───────────────────────────────────────────────────────────────────────
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const full = new Map([[HEAD, "full"]]);
// Defaults keep each row about ONE fact. A row that has to restate six unrelated facts stops being readable,
// and an unreadable table is one nobody notices a hole in.
const facts = (over) => ({
  head: HEAD,
  pushed: [HEAD],
  ciLedger: full,
  evalLedger: [`${HEAD} `],
  reviewLedger: [`${HEAD} `],
  configChanged: false,
  productChanged: false,
  releaseTags: [],
  ...over,
});

/** [name, facts, expected, arm] */
const TABLE = [
  ["an unreadable CI ledger is a DENY, not an empty one", facts({ ciLedger: null }), "deny", ARMS.CI_LEDGER_UNREADABLE],
  ["a tip with no FULL stamp is refused", facts({ ciLedger: new Map([[HEAD, "fast"]]) }), "deny", ARMS.TIP_UNSTAMPED],
  [
    "an ungated intermediate commit is refused even when the tip is full",
    facts({ pushed: [HEAD, OTHER] }),
    "deny",
    ARMS.COMMITS_UNSTAMPED,
  ],
  [
    "a configuration change with no eval ledger is refused",
    facts({ configChanged: true, evalLedger: null }),
    "deny",
    ARMS.EVAL_LEDGER_UNREADABLE,
  ],
  [
    "a configuration change stamped for another commit is refused",
    facts({ configChanged: true, evalLedger: [OTHER] }),
    "deny",
    ARMS.EVAL_STAMP_MISMATCH,
  ],
  ["a configuration change stamped for HEAD is allowed", facts({ configChanged: true }), "allow", ARMS.ALLOW],
  [
    "product code with no review ledger at all is refused",
    facts({ productChanged: true, reviewLedger: null }),
    "deny",
    ARMS.REVIEW_LEDGER_UNREADABLE,
  ],
  [
    "product code reviewed at another commit is refused",
    facts({ productChanged: true, reviewLedger: [OTHER] }),
    "deny",
    ARMS.REVIEW_MISSING,
  ],
  ["product code reviewed at HEAD is allowed", facts({ productChanged: true }), "allow", ARMS.ALLOW],
  [
    "a docs-only push never meets the review arm",
    facts({ productChanged: false, reviewLedger: null }),
    "allow",
    ARMS.ALLOW,
  ],
  [
    "a release tag with no authorization is refused",
    facts({ releaseTags: [{ tag: "api-v1.4.0", authorized: false }] }),
    "deny",
    ARMS.RELEASE_UNAUTHORIZED,
  ],
  [
    "an authorized release tag is allowed",
    facts({ releaseTags: [{ tag: "api-v1.4.0", authorized: true }] }),
    "allow",
    ARMS.ALLOW,
  ],
  [
    "the release arm outranks the cheaper gates, so a refused release says RELEASE",
    facts({ releaseTags: [{ tag: "v2.0.0", authorized: false }], ciLedger: new Map([[HEAD, "fast"]]) }),
    "deny",
    ARMS.RELEASE_UNAUTHORIZED,
  ],
  ["a push that changes no configuration never meets the eval arm", facts({ evalLedger: null }), "allow", ARMS.ALLOW],
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

// ── half three: the scope, against a real linked worktree ────────────────────────────────────────
//
// The hook is driven in `--probe` mode: same payload, same facts, same decision, no ledger line and no
// permission verdict. The worktree is created with `--no-checkout` (no files, so it costs a directory and a
// ref) and its HEAD is moved one commit back, so a probe from inside it must report THAT head — which is how
// this check tells "the hook noticed the worktree" from "the hook read the root's facts and called it in".
const git = (args, cwd = root) => spawnSync("git", args, { cwd, encoding: "utf8" });
const probeHook = (payload) => {
  const res = spawnSync("node", [path.join(root, HOOK), "--probe"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (res.status !== 0) return { error: `the hook exited ${res.status}: ${(res.stderr ?? "").trim()}` };
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: `the hook printed no probe report (stdout: ${JSON.stringify((res.stdout ?? "").slice(0, 120))})` };
  }
};
const scratch = mkdtempSync(path.join(tmpdir(), "everdict-guardrails-"));
const linked = path.join(scratch, "linked");
const foreign = path.join(scratch, "foreign");
try {
  const add = git(["worktree", "add", "--no-checkout", "--detach", "--quiet", linked, "HEAD"]);
  const rootHead = git(["rev-parse", "HEAD"]).stdout.trim();
  const parent = git(["rev-parse", "HEAD~1"]).stdout.trim();
  if (add.status !== 0 || parent.length !== 40) {
    fail(
      `could not create a linked worktree to drive the scope against (${(add.stderr ?? "").trim() || "no parent commit"}). The scope half was not checked, and an unasked question is not a pass.`,
    );
  } else {
    git(["reset", "--soft", parent], linked); // moves the linked worktree's HEAD only; no files to touch
    git(["init", "-q", foreign]);
    const push = (cwd, command = "git push origin HEAD") => ({ tool_input: { command }, cwd });
    /** [name, payload, inScope, head the probe must report when in scope] */
    const SCOPE = [
      ["a push from the repository root is in scope", push(root), true, rootHead],
      ["a push whose cwd is a linked worktree is in scope, at THAT worktree's head", push(linked), true, parent],
      [
        "a push through `git -C <linked worktree>` is in scope, at that worktree's head",
        push(root, `git -C ${linked} push origin HEAD`),
        true,
        parent,
      ],
      [
        "a leading `cd <linked worktree>` before the push moves the scope with it",
        push(root, `cd ${linked} && git push origin HEAD`),
        true,
        parent,
      ],
      ["a push from another repository is out of scope", push(foreign), false],
      ["a command that is not a push is out of scope", push(root, "git status"), false],
    ];
    for (const [name, payload, inScope, head] of SCOPE) {
      const r = probeHook(payload);
      if (r.error) {
        fail(`scope: ${name} — ${r.error}`);
        continue;
      }
      if (r.inScope !== inScope) {
        fail(
          `scope: ${name} — expected ${inScope ? "IN" : "OUT OF"} scope, got ${r.inScope ? "in" : "out"}${r.why ? ` (${r.why})` : ""}. ${inScope ? "A push the hook does not see is a push nothing gates and nothing records." : ""}`,
        );
        continue;
      }
      if (inScope && r.head !== head) {
        fail(
          `scope: ${name} — in scope, but the facts came from the wrong checkout (head ${String(r.head).slice(0, 9)}, expected ${head.slice(0, 9)}). The gate would stamp-check a commit that is not the one being pushed.`,
        );
      }
      if (inScope && typeof r.decision?.arm !== "string") {
        fail(`scope: ${name} — in scope, but the probe reported no decision arm.`);
      }
    }
  }
} finally {
  git(["worktree", "remove", "--force", linked]);
  rmSync(scratch, { recursive: true, force: true });
  git(["worktree", "prune"]);
}

// ── half four: the watcher refuses in dry-run ────────────────────────────────────────────────────
//
// `pnpm ci:local` reads the bands dry-run on every full run. Until 2026-09-06 a 3σ breach in that mode printed
// "would file" and exited 0, so the one thing here that starts work without a person was, on its only
// automatic path, a printout. The fixtures are two gate-log series over the same thirty-sample history: one
// whose latest decision breaches at ~3.7σ and one that does not.
const WATCH = path.join(root, "scripts", "bands", "watch.mjs");
const FIXTURES = path.join(root, "scripts", "bands", "fixtures");
const watch = (fixture) =>
  spawnSync("node", [WATCH, "--dry-run", "--only", "gate-denial-rate", "--source-dir", path.join(FIXTURES, fixture)], {
    cwd: root,
    encoding: "utf8",
  });
if (!existsSync(path.join(FIXTURES, "breach", "everdict-gate-log.jsonl"))) {
  fail("scripts/bands/fixtures/breach/ is missing — the watcher's refusal cannot be driven, which is not a pass.");
} else {
  const breach = watch("breach");
  if (breach.status === 0) {
    fail(
      "watcher: a 3σ breach in --dry-run exited 0. The gate reads the bands dry-run, so a breach that does not refuse is a breach nobody files.",
    );
  } else if (!/3σ/.test(breach.stdout) || !/pnpm watch-bands/.test(`${breach.stdout}${breach.stderr}`)) {
    fail(
      `watcher: the breach refused, but without naming the tier and the command that files the intent. A refusal that does not say what to run is a wall.\n${breach.stdout}${breach.stderr}`,
    );
  }
  const quiet = watch("quiet");
  if (quiet.status !== 0) {
    fail(
      `watcher: the quiet fixture was refused (exit ${quiet.status}) — a gate that refuses on no breach is a gate that gets switched off.\n${quiet.stdout}${quiet.stderr}`,
    );
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error(`\n✖ guardrails: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\n  The push gate is what every other gate is enforced BY. See .claude/rules/ci.md.");
  process.exit(1);
}
console.log(
  `PASS guardrails: the push gate is wired, its decision holds over ${TABLE.length} cases, its scope reaches a linked worktree, and the watcher refuses a fixture breach.`,
);
