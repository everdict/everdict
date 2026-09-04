#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: Bash) — blocks `git push` unless the local CI parity gate
// (scripts/ci-local.mjs) has passed for the current HEAD. Wired in .claude/settings.json; see
// .claude/rules/ci.md + skill `ci`. Reads the hook payload from stdin, writes a permission decision
// to stdout. Anything that is not a push of THIS repo exits silently (normal permission flow).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // malformed payload — never wedge the session on a broken hook
}
const command = input?.tool_input?.command;
if (typeof command !== "string") process.exit(0);

// A push = any shell segment invoking `git … push`. Segments split on && || ; | and newlines so
// compound commands (`cd x && git push`) are still caught.
const segments = command.split(/&&|\|\||[;|\n]/);
const gitPush = /^(?:command\s+)?git(?:\s+(?:-C\s+(\S+)|--[\w-]+(?:=\S+)?|-\w+))*\s+push\b/;
const pushSegment = segments.map((s) => s.trim()).find((s) => gitPush.test(s));
if (!pushSegment) process.exit(0);

// Only guard THIS repo: a push driven from another cwd (or `git -C <elsewhere>`) is out of scope.
const cTarget = pushSegment.match(gitPush)?.[1];
const effectiveCwd = cTarget ? path.resolve(input?.cwd ?? root, cTarget) : (input?.cwd ?? root);
const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: effectiveCwd, encoding: "utf8" });
if (toplevel.status !== 0 || toplevel.stdout.trim() !== root) process.exit(0);

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

// ── EVERY COMMIT IN THE PUSH, NOT ONLY ITS TIP (arch-review 57 follow-up) ─────────────────────────
//
// This compared the stamp to HEAD, so a batch of eight commits was let through on one gated commit and seven
// that had never been built. The history then advertises a bisectability it does not have — and the hole is
// invisible, because GitHub also only runs checks on the tip, so nothing downstream contradicts it.
//
// The stamp is a ledger now (`<sha> full|fast`). Every commit ahead of the remote must appear in it, and the
// TIP must be `full`: the expensive checks — gitleaks over all history, the web build, the mutation suite —
// answer questions about the tree being published, while lint/typecheck/test are what bisect actually lands
// on. `pnpm ci:commits` fills the intermediate ones.
// ⚠️ A LEDGER THAT CANNOT BE READ IS A DENY, NEVER A CRASH. This read had no guard, so on a checkout that
// had never been gated `readFileSync` threw — and a PreToolUse hook that exits non-zero without writing a
// decision lets the tool call through. The gate failed OPEN on precisely the state that means "nothing here
// has ever been gated". `deny()` is used for it, because "cannot find out" is an escalation, not a pass.
const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${reason} See .claude/rules/ci.md.`,
      },
    }),
  );
  process.exit(0);
};

const readLedger = (name, missing) => {
  try {
    return readFileSync(path.join(root, ".git", name), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    deny(missing);
    return []; // unreachable; deny() exits
  }
};

const ledger = new Map();
for (const line of readLedger(
  "everdict-ci-ok",
  "git push blocked: no CI-parity ledger (.git/everdict-ci-ok) — nothing in this checkout has ever been gated. Run `pnpm ci:local`.",
)) {
  const [sha, level] = line.split(" ");
  // A bare sha predates the ledger and attested the full gate.
  if (sha !== undefined) ledger.set(sha, level ?? "full");
}

// What this push would carry. The remote's own ref is the base — anything it already has was gated when it
// was pushed. If that ref cannot be resolved (a first push, a detached setup), fall back to guarding HEAD
// alone rather than refusing everything.
const remote = spawnSync("git", ["remote"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean)[0];
const base = `${remote}/main`;
const haveBase =
  remote !== undefined && spawnSync("git", ["rev-parse", "--verify", "--quiet", base], { cwd: root }).status === 0;
const pushed = haveBase
  ? spawnSync("git", ["rev-list", `${base}..HEAD`], { cwd: root, encoding: "utf8" })
      .stdout.split("\n")
      .filter(Boolean)
  : [head];

// ── THE CONFIGURATION THAT STEERS THE AGENT IS TESTED TOO ────────────────────────────────────────
//
// `pnpm agent-evals` is not in `ci:local` and not in CI: it needs a model, a GitHub runner has no login, and
// the secret that would give it one is a cost of the delivery choice rather than of the suite (five local
// runs used the machine's existing login). `protocol-mutations` left CI for the same shape of reason. What
// keeps it from sliding back to advisory is this arm — a push that CHANGES the configuration under test must
// carry a green run of it.
//
// Tip-only, unlike the CI ledger. That one is per-commit because a bisect lands on an intermediate commit;
// nobody bisects a skill's wording, and what the suite answers is a question about the tree being published.
const CONFIG_PATHS = ["CLAUDE.md", ".claude", "evals"];
const touchedConfig = haveBase
  ? spawnSync("git", ["diff", "--name-only", `${base}..HEAD`, "--", ...CONFIG_PATHS], { cwd: root, encoding: "utf8" })
  : spawnSync("git", ["show", "--name-only", "--format=", "HEAD", "--", ...CONFIG_PATHS], {
      cwd: root,
      encoding: "utf8",
    });
const configChanged = touchedConfig.status === 0 && touchedConfig.stdout.trim() !== "";

const unstamped = pushed.filter((sha) => !ledger.has(sha));
const tipLevel = ledger.get(head);

if (configChanged) {
  const evals = readLedger(
    "everdict-evals-ok",
    `git push blocked: this push changes the configuration that steers the agent (${CONFIG_PATHS.join(", ")}) and there is no agent-eval stamp. Run \`pnpm agent-evals\`.`,
  );
  if (!evals.some((line) => line.split(" ")[0] === head)) {
    deny(
      `git push blocked: this push changes ${CONFIG_PATHS.join(", ")}, and .git/everdict-evals-ok does not stamp HEAD ${head.slice(0, 9)}. The structural checks cannot ask whether the agent still does the work to the same standard — run \`pnpm agent-evals\`.`,
    );
  }
}

if (head !== "" && unstamped.length === 0 && tipLevel === "full") process.exit(0);

const reason =
  tipLevel !== "full"
    ? `git push blocked: HEAD ${head.slice(0, 9)} has no FULL gate stamp. Run \`pnpm ci:local\` (mirrors .github/workflows/ci.yml), then push.`
    : `git push blocked: ${unstamped.length} of the ${pushed.length} commit(s) this push carries were never gated — ${unstamped
        .slice(0, 3)
        .map((s) => s.slice(0, 9))
        .join(
          ", ",
        )}${unstamped.length > 3 ? ", …" : ""}. GitHub only checks the tip too, so these would be holes nothing contradicts. Run \`pnpm ci:commits\`.`;

deny(reason);
