#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: Bash) — blocks a push unless the local gates have passed for the
// current HEAD. Wired in .claude/settings.json; see .claude/rules/ci.md + skill `ci`. Reads the hook payload
// from stdin, writes a permission decision to stdout. Anything that is not a push of THIS repo exits silently
// (normal permission flow).
//
// This file GATHERS FACTS; `scripts/hooks/gate-decision.mjs` decides, so `pnpm guardrails` can drive the
// decision over a truth table without an env var that would make the ledgers forgeable.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATHSPEC, PRODUCT_PATHS, RELEASE_TAG, decideGate } from "./gate-decision.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // malformed payload — never wedge the session on a broken hook
}
const command = input?.tool_input?.command;
if (typeof command !== "string") process.exit(0);

// A push = any shell segment invoking `git … push`. Segments split on && || ; | and newlines so a compound
// command — a `cd` and then a push, joined on one line — is still caught.
//
// ⚠️ THE SEGMENTER MATCHES TEXT, INCLUDING TEXT THAT IS NOT A COMMAND. The sentence above used to carry a
// literal example of that compound form, and writing THIS FILE through a shell heredoc was therefore denied
// by this very gate: the heredoc body is part of the command string, `&&` splits it, and the right half
// begins with the two words the matcher looks for. Anything that merely quotes a push after a separator — a
// doc, a commit message, a grep — is refused the same way. That is the safe direction for a gate whose
// failure mode is a false ALLOW, and it is left as is deliberately; what is not acceptable is being surprised
// by it, so it is written down here and in rule `ci`. Write such a file with an editor, not a heredoc.
const segments = command.split(/&&|\|\||[;|\n]/);
const gitPush = /^(?:command\s+)?git(?:\s+(?:-C\s+(\S+)|--[\w-]+(?:=\S+)?|-\w+))*\s+push\b/;
const pushSegment = segments.map((s) => s.trim()).find((s) => gitPush.test(s));
if (!pushSegment) process.exit(0);

// Only guard THIS repo: a push driven from another cwd (or `git -C <elsewhere>`) is out of scope.
const cTarget = pushSegment.match(gitPush)?.[1];
const effectiveCwd = cTarget ? path.resolve(input?.cwd ?? root, cTarget) : (input?.cwd ?? root);
const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: effectiveCwd, encoding: "utf8" });
if (toplevel.status !== 0 || toplevel.stdout.trim() !== root) process.exit(0);

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const head = git("rev-parse", "HEAD").stdout.trim();

/** null means the ledger could not be READ, which is a different answer from "it is empty". */
const readLedger = (name) => {
  try {
    return readFileSync(path.join(root, ".git", name), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
};
const ciLines = readLedger("everdict-ci-ok");
const ciLedger =
  ciLines === null
    ? null
    : new Map(
        ciLines.map((line) => {
          const [sha, level] = line.split(" ");
          return [sha, level ?? "full"]; // a bare sha predates the ledger and attested the full gate
        }),
      );

// What this push would carry. The remote's own ref is the base — anything it already has was gated when it
// was pushed. If that ref cannot be resolved (a first push, a detached setup), fall back to guarding HEAD
// alone rather than refusing everything.
const remote = git("remote").stdout.split("\n").filter(Boolean)[0];
const base = `${remote}/main`;
const haveBase =
  remote !== undefined && spawnSync("git", ["rev-parse", "--verify", "--quiet", base], { cwd: root }).status === 0;
const pushed = haveBase ? git("rev-list", `${base}..HEAD`).stdout.split("\n").filter(Boolean) : [head];

// Three dots: the diff from the MERGE BASE. Two dots asks "what does HEAD have that base does not", which on a
// branch behind base answers with base's own work inverted — so a config file main changed and this branch
// never touched would read as a configuration change here. Over-gating is the safe direction and it is still
// the wrong question.
const touched = haveBase
  ? git("diff", "--name-only", `${base}...HEAD`, "--", ...CONFIG_PATHSPEC)
  : git("show", "--name-only", "--format=", "HEAD", "--", ...CONFIG_PATHSPEC);
const configChanged = touched.status === 0 && touched.stdout.trim() !== "";

// Product code — a docs-only or intent-only push carries nothing a review would find, and pays nothing.
const product = haveBase
  ? git("diff", "--name-only", `${base}...HEAD`, "--", ...PRODUCT_PATHS)
  : git("show", "--name-only", "--format=", "HEAD", "--", ...PRODUCT_PATHS);
const productChanged = product.status === 0 && product.stdout.trim() !== "";

// Release tags pointing at HEAD. Read from the TAG rather than from the push command: a tag created in
// another checkout and pushed from this one is still a release leaving this machine, and parsing which refs a
// shell string would push is a guess where `--points-at` is an answer.
const releaseTags = git("tag", "--points-at", "HEAD")
  .stdout.split("\n")
  .map((t) => t.trim())
  .filter((t) => t !== "" && RELEASE_TAG.test(t))
  .map((tag) => ({
    tag,
    // Committed, not merely present: an authorization that lives only in the working tree did not travel with
    // the tag it authorizes.
    authorized: git("cat-file", "-e", `HEAD:releases/${tag}.md`).status === 0,
  }));

const decision = decideGate({
  head,
  pushed,
  ciLedger,
  evalLedger: readLedger("everdict-evals-ok"),
  reviewLedger: readLedger("everdict-review-ok"),
  configChanged,
  productChanged,
  releaseTags,
});
// ── the gate records what it decided ─────────────────────────────────────────────────────────────
//
// `pnpm guardrails` proves this decision is CORRECT over constructed facts; nothing recorded what it actually
// decided, so "how long did this gate cost" had no data and "what has it refused" had no denominator. The
// refusals are the half that proves a control was load-bearing rather than decorative, and they were being
// discarded at process exit.
//
// Written AFTER the early exits on purpose: the hook is wired on the Bash matcher, so recording any earlier
// would produce a shell transcript rather than an audit trail. Wrapped, because a hook that throws while
// recording is worse than one that records nothing — the decision must survive a failed write. Local to
// `.git/`, because it describes this checkout's operations rather than the project's history.
try {
  appendFileSync(
    path.join(root, ".git", "everdict-gate-log.jsonl"),
    `${JSON.stringify({
      at: new Date().toISOString(),
      verdict: decision.allow ? "allow" : "deny",
      arm: decision.arm,
      head,
      pushed: pushed.length,
      configChanged,
      productChanged,
      releaseTags: releaseTags.map((t) => t.tag),
      reason: decision.allow ? undefined : decision.reason,
    })}\n`,
  );
} catch {
  // a decision that cannot be recorded is still a decision
}

if (decision.allow) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${decision.reason} See .claude/rules/ci.md.`,
    },
  }),
);
