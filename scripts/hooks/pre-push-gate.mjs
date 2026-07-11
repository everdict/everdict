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
let stamp = "";
try {
  stamp = readFileSync(path.join(root, ".git", "everdict-ci-ok"), "utf8").trim();
} catch {
  // no stamp yet
}
if (stamp === head && head !== "") process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `git push blocked: the local CI parity gate has not passed for HEAD ${head.slice(0, 9)}. Run \`pnpm ci:local\` (mirrors .github/workflows/ci.yml; stamps .git/everdict-ci-ok on a clean green tree), then push. See .claude/rules/ci.md.`,
    },
  }),
);
