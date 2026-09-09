#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: Bash) — blocks a push unless the local gates have passed for the
// current HEAD. Wired in .claude/settings.json; see .claude/rules/ci.md + skill `ci`. Reads the hook payload
// from stdin, writes a permission decision to stdout. Anything that is not a push of THIS repo exits silently
// (normal permission flow).
//
// This file GATHERS FACTS; `scripts/hooks/gate-decision.mjs` decides, so `pnpm guardrails` can drive the
// decision over a truth table without an env var that would make the ledgers forgeable.
//
// `--probe` gathers the same facts from the same payload, runs the same decision, and prints them as JSON —
// WITHOUT recording a ledger line and WITHOUT emitting a permission decision. It exists so `pnpm guardrails`
// can drive this file against a REAL linked worktree and read what it would have done; the wired hook never
// passes it, and guardrails refuses a settings file that does.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATHSPEC, PRODUCT_PATHS, RELEASE_TAG, decideGate } from "./gate-decision.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = process.argv.includes("--probe");
const report = (facts) => {
  if (probe) process.stdout.write(`${JSON.stringify(facts)}\n`);
  process.exit(0);
};

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // malformed payload — never wedge the session on a broken hook
}
const command = input?.tool_input?.command;
if (typeof command !== "string") report({ inScope: false, why: "no command in the payload" });

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
if (!pushSegment) report({ inScope: false, why: "not a push" });

// ── which checkout is pushing, and is it ours ────────────────────────────────────────────────────
//
// ⚠️ THE SCOPE USED TO BE THE TOPLEVEL, AND A LINKED WORKTREE HAS ITS OWN. `git rev-parse --show-toplevel`
// compared to the repository root let a push from `git worktree add` — which the eval runner, the reviewer,
// the design pass and the commit gate all create, and which a session can `git -C` into — exit this hook
// silently, with no ledger line. Two synthetic payloads confirmed it during the 2026-09-06 audit while a
// linked worktree checked out at `main` was live. What every checkout of this repository SHARES is the
// common git directory: the ledgers live in it, the refs live in it, and a push from any of them leaves
// this machine through it. So the scope is the common dir, and every fact below is read from the checkout
// that is actually pushing — its HEAD, its diff, its tags — not from the root's.
//
// The checkout that pushes is the session's cwd, moved by every plain `cd <path>` segment BEFORE the push (a
// `cd` into a worktree and then a push, on one line, is the ordinary way a session gets there), then by a
// `git -C <dir>` on the push itself. Only a bare `cd <literal>` is followed; anything cleverer (`cd "$X"`,
// `pushd`, a subshell) leaves the cwd where it was, which over-gates the ROOT rather than under-gating the
// worktree — the safe direction for a gate whose failure mode is a false allow.
let cwd = input?.cwd ?? root;
for (const raw of segments.map((s) => s.trim())) {
  if (raw === pushSegment) break;
  const cd = /^cd\s+([^\s"'$`;&|]+)$/.exec(raw);
  if (cd) cwd = path.resolve(cwd, cd[1]);
}
const cTarget = pushSegment.match(gitPush)?.[1];
if (cTarget) cwd = path.resolve(cwd, cTarget);
// The COMMON git directory as a REAL path: a root reached through a symlink and a worktree whose `.git` file
// records the canonical path would otherwise name the same directory two ways, and a mismatch here is a
// silent allow.
const commonOf = (dir) => {
  const res = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8" });
  if (res.status !== 0) return undefined;
  try {
    return realpathSync(path.resolve(dir, res.stdout.trim()));
  } catch {
    return undefined;
  }
};
const ownCommonDir = commonOf(root);
if (ownCommonDir === undefined) {
  // The gate cannot read ITS OWN repository. That is not "another repository" and it is not a pass: cannot
  // find out is an escalation (rule `protocol` L2), and a hook that shrugged here would let every push
  // through on the day git itself is broken.
  if (probe) report({ inScope: false, why: "own repository unreadable" });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "push blocked: the push gate could not read its own repository (git rev-parse --git-common-dir failed at the root). Fix git before pushing. See .claude/rules/ci.md.",
      },
    }),
  );
  process.exit(0);
}
const commonDir = commonOf(cwd);
if (commonDir === undefined || commonDir !== ownCommonDir) {
  report({ inScope: false, why: "another repository", cwd, commonDir: commonDir ?? null });
}

const git = (...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const head = git("rev-parse", "HEAD").stdout.trim();

/** null means the ledger could not be READ, which is a different answer from "it is empty". */
const readLedger = (name) => {
  try {
    return readFileSync(path.join(commonDir, name), "utf8").split("\n").filter(Boolean);
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

// ── A STAMP IS ABOUT A TREE, AND A REWRITE KEEPS THE TREE ───────────────────────────────────────────
//
// `fast` says one thing: lint, typecheck and test passed on this commit's content. That is a property of the
// TREE and of the diff to its parent, and neither moves when a commit is reworded, reordered, or rebased onto
// an identical predecessor — but the sha does, so every stamp died and the walk started over. Measured on the
// session that wrote this: three history repairs, each invalidating sixteen-to-twenty stamps, each costing an
// hour of the same lint+typecheck+test over trees that had already passed them.
//
// So a pushed commit inherits a `fast` stamp when some stamped commit has the SAME tree and the same parent
// tree. Both halves are needed: the suite is a function of the tree, and `pnpm fix-proof` — which the same
// walk runs — is a function of the DIFF, so a tree whose parent moved has not been proved.
//
// ⚠️ IT GRANTS `fast` AND NEVER `full`. `pnpm ci:local` also runs gitleaks over ALL history and
// `pnpm intent-chain` over the commit graph, and those are not tree properties: two identical trees on
// different ancestries are different answers. The tip still has to carry its own `full`.
// ⚠️ AND THE KEY CARRIES THE MESSAGE, BECAUSE THE RULE DOES. `fix-proof` applies to a commit because its
// SUBJECT says `fix:`, and what it exempts comes from `Regression-test:` / `Fixture-only:` lines in the body —
// none of which is in the tree. So a `chore:` commit stamped fast, reworded to `fix(x): …` with an identical
// tree and parent, would have inherited a stamp for a rule it was never checked against. Found by
// `pnpm review` on the commit that introduced this inheritance.
//
// The message digest is the whole message rather than the three facts derived from it: a reword is rare, and
// missing an inheritance costs one re-run while granting a wrong one costs a certificate.
const treeKey = (sha) => {
  const tree = git("rev-parse", `${sha}^{tree}`).stdout.trim();
  const parentTree = git("rev-parse", `${sha}^^{tree}`).stdout.trim(); // "" for a root commit
  if (tree === "") return undefined;
  const message = createHash("sha256")
    .update(git("log", "-1", "--format=%B", sha).stdout)
    .digest("hex");
  return `${tree} ${parentTree} ${message}`;
};
if (ciLedger !== null) {
  const stampedTrees = new Set();
  for (const [sha, level] of ciLedger) {
    if (level !== "fast" && level !== "full") continue;
    const key = treeKey(sha);
    if (key !== undefined) stampedTrees.add(key);
  }
  for (const sha of git("rev-list", "HEAD", "--max-count=400").stdout.split("\n").filter(Boolean)) {
    if (ciLedger.has(sha)) continue;
    const key = treeKey(sha);
    if (key !== undefined && stampedTrees.has(key)) ciLedger.set(sha, "fast");
  }
}

// What this push would carry. The remote's own ref is the base — anything it already has was gated when it
// was pushed. If that ref cannot be resolved (a first push, a detached setup), fall back to guarding HEAD
// alone rather than refusing everything.
const remote = git("remote").stdout.split("\n").filter(Boolean)[0];
const base = `${remote}/main`;
const haveBase =
  remote !== undefined && spawnSync("git", ["rev-parse", "--verify", "--quiet", base], { cwd }).status === 0;
const pushed = haveBase ? git("rev-list", `${base}..HEAD`).stdout.split("\n").filter(Boolean) : [head];

// Three dots: the diff from the MERGE BASE. Two dots asks "what does HEAD have that base does not", which on a
// branch behind base answers with base's own work inverted — so a config file main changed and this branch
// never touched would read as a configuration change here. Over-gating is the safe direction and it is still
// the wrong question.
//
// ⚠️ AND A FAILED READ MEANS "CHANGED", NOT "UNCHANGED". This was `touched.status === 0 && …`, so any git
// error — a version rejecting the `:(exclude)` magic pathspec, a transient failure, a corrupt index — made
// `configChanged` false, which does not deny anything: it makes the eval-stamp and review arms sit out, and
// the push goes through on the CI ledger alone. The gate's own ledger reads were hardened against exactly
// this shape earlier (a missing ledger used to fail OPEN because a hook exiting non-zero lets the tool
// through); the two facts BESIDE the ledgers were left reading a status code, which is the same collapse
// wearing a different spelling. Cannot-find-out is an escalation, never a pass (rule `protocol` L2), and
// two lines up this file already says over-gating is the safe direction.
const changedUnderPathspec = (label, ...pathspec) => {
  const result = haveBase
    ? git("diff", "--name-only", `${base}...HEAD`, "--", ...pathspec)
    : git("show", "--name-only", "--format=", "HEAD", "--", ...pathspec);
  if (result.status !== 0) {
    process.stderr.write(
      `everdict push gate: could not read what this push changes under ${label} (git exited ${result.status}). Treating it as CHANGED, so the stamps for it are required.\n`,
    );
    return true;
  }
  return result.stdout.trim() !== "";
};
const configChanged = changedUnderPathspec("the configuration", ...CONFIG_PATHSPEC);

// Product code — a docs-only or intent-only push carries nothing a review would find, and pays nothing.
const productChanged = changedUnderPathspec("product code", ...PRODUCT_PATHS);

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

if (probe) {
  report({
    inScope: true,
    cwd,
    commonDir,
    head,
    pushed: pushed.length,
    configChanged,
    productChanged,
    releaseTags: releaseTags.map((t) => t.tag),
    decision: { allow: decision.allow, arm: decision.arm },
  });
}

// ── the gate records what it decided ─────────────────────────────────────────────────────────────
//
// `pnpm guardrails` proves this decision is CORRECT over constructed facts; nothing recorded what it actually
// decided, so "how long did this gate cost" had no data and "what has it refused" had no denominator. The
// refusals are the half that proves a control was load-bearing rather than decorative, and they were being
// discarded at process exit.
//
// Written AFTER the early exits on purpose: the hook is wired on the Bash matcher, so recording any earlier
// would produce a shell transcript rather than an audit trail. Wrapped, because a hook that throws while
// recording is worse than one that records nothing — the decision must survive a failed write. In the
// COMMON git directory, because it describes this repository's operations from every checkout that shares it.
try {
  appendFileSync(
    path.join(commonDir, "everdict-gate-log.jsonl"),
    `${JSON.stringify({
      at: new Date().toISOString(),
      verdict: decision.allow ? "allow" : "deny",
      arm: decision.arm,
      head,
      pushed: pushed.length,
      configChanged,
      productChanged,
      releaseTags: releaseTags.map((t) => t.tag),
      cwd: cwd === root ? undefined : cwd,
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
