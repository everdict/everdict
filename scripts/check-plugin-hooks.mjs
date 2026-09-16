#!/usr/bin/env node
// Plugin-hook guard — the two hooks are CONTROLS, and a control nobody has seen refuse is a claim.
//
// `plugin/hooks/capture-guard.mjs` decides whether a coding session may end, and `session-start.mjs` decides
// what a session is told about the service it is about to change. Neither is imported by any package, so
// `pnpm test` cannot reach them: they are executables a different program (the Claude Code harness) runs by
// piping JSON at their stdin. This check is that program, in miniature — every branch, asserted on the exact
// contract the harness reads back.
//
// The branch that matters most is the REFUSAL. A guard that silently stopped blocking would look exactly like
// a well-behaved session: green console, nothing in the log, and nothing on the record — which is the failure
// the guard exists to make impossible.
//
// watches: nothing — it does not scan for a vocabulary; it RUNS both hooks and asserts the JSON contract the
// harness reads back. The corpus guard is the existence check above: a renamed hook fails this check loudly.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooks = {
  capture: path.join(root, "plugin", "hooks", "capture-guard.mjs"),
  sessionStart: path.join(root, "plugin", "hooks", "session-start.mjs"),
};

// AN EMPTY CORPUS IS NOT A PASS (CLAUDE.md). A renamed or deleted hook must fail this check loudly rather
// than let it report success over nothing.
for (const [name, file] of Object.entries(hooks)) {
  if (!existsSync(file)) {
    console.error(`plugin hook check FAILED: ${name} hook is missing at ${path.relative(root, file)}`);
    process.exit(1);
  }
}

const work = mkdtempSync(path.join(tmpdir(), "everdict-hook-"));
const transcript = (name, lines) => {
  const file = path.join(work, `${name}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
};
const toolUse = (name, input = {}) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});

const CHANGED_ONLY = transcript("changed-only", [toolUse("Edit", { file_path: "/x/y.ts" })]);
const CHANGED_AND_RECORDED = transcript("changed-and-recorded", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__create_knowledge_entry", { kind: "finding" }),
]);
const COMMITTED_ONLY = transcript("committed-only", [toolUse("Bash", { command: "git commit -m x" })]);
// A session whose record is its JUDGEMENT rather than a knowledge entry has recorded (the ownership
// protocol's executor claim, `docs/architecture/change-campaign-spec.md`). Its own branch, because the
// recording vocabulary is a regex and a regex that silently stops matching one name looks like a quiet session.
const CHANGED_AND_JUDGED = transcript("changed-and-judged", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__publish_checkpoint", { role: "executor" }),
]);
const READ_ONLY = transcript("read-only", [toolUse("Read", { file_path: "/x/y.ts" })]);

const run = (hook, payload, env = {}) =>
  execFileSync("node", [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, EVERDICT_WORKSPACE: "", EVERDICT_BREAK_GLASS: "", ...env },
  });

const failures = [];
const check = (label, actual, predicate, expectation) => {
  let parsed;
  try {
    parsed = JSON.parse(actual || "{}");
  } catch {
    failures.push(`${label}: hook wrote something that is not JSON — the harness would ignore it entirely`);
    return;
  }
  if (!predicate(parsed))
    failures.push(`${label}: expected ${expectation}, got ${JSON.stringify(parsed).slice(0, 200)}`);
};

const blocks = (out) => out.decision === "block" && typeof out.reason === "string" && out.reason.length > 0;
const allows = (out) => out.decision === undefined;

// ── the capture guard, branch by branch ──────────────────────────────────────────────────────────
check(
  "capture/opted-in + changed code + recorded nothing",
  run(hooks.capture, { cwd: work, transcript_path: CHANGED_ONLY }, { EVERDICT_WORKSPACE: "acme" }),
  blocks,
  "a block carrying the reason",
);
check(
  "capture/a commit counts as changing code",
  run(hooks.capture, { cwd: work, transcript_path: COMMITTED_ONLY }, { EVERDICT_WORKSPACE: "acme" }),
  blocks,
  "a block (the session committed)",
);
check(
  "capture/recorded → allowed",
  run(hooks.capture, { cwd: work, transcript_path: CHANGED_AND_RECORDED }, { EVERDICT_WORKSPACE: "acme" }),
  allows,
  "no decision (the session recorded)",
);
check(
  "capture/a published checkpoint counts as recording",
  run(hooks.capture, { cwd: work, transcript_path: CHANGED_AND_JUDGED }, { EVERDICT_WORKSPACE: "acme" }),
  allows,
  "no decision (the session filed its judgement)",
);
check(
  "capture/read-only session → allowed",
  run(hooks.capture, { cwd: work, transcript_path: READ_ONLY }, { EVERDICT_WORKSPACE: "acme" }),
  allows,
  "no decision (nothing was changed)",
);
check(
  "capture/second pass → allowed (no Stop loop)",
  run(
    hooks.capture,
    { cwd: work, transcript_path: CHANGED_ONLY, stop_hook_active: true },
    { EVERDICT_WORKSPACE: "acme" },
  ),
  allows,
  "no decision — stop_hook_active is the harness's loop guard",
);
check(
  "capture/no workspace → allowed (the repository never opted in)",
  run(hooks.capture, { cwd: work, transcript_path: CHANGED_ONLY }),
  allows,
  "no decision",
);
check(
  "capture/break-glass → allowed AND the reason is reported",
  run(
    hooks.capture,
    { cwd: work, transcript_path: CHANGED_ONLY },
    { EVERDICT_WORKSPACE: "acme", EVERDICT_BREAK_GLASS: "offline" },
  ),
  (out) => allows(out) && typeof out.systemMessage === "string" && out.systemMessage.includes("offline"),
  "no decision plus a systemMessage naming the reason",
);

// ── session start: the two branches a session actually reads ─────────────────────────────────────
const context = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
check(
  "session-start/no workspace → says so, and does NOT invent one",
  run(hooks.sessionStart, { cwd: work }),
  (out) => context(out).includes("not resolved") && !context(out).includes("workspace: **"),
  "the unresolved branch",
);
check(
  "session-start/workspace resolved → names it and the repository",
  run(hooks.sessionStart, { cwd: root }, { EVERDICT_WORKSPACE: "acme" }),
  // The repository line is the one that regressed once already: it read `origin` on a repo whose remote is
  // named `everdict`, and reported "no git remote" for a repository that has one.
  (out) => context(out).includes("workspace: **acme**") && context(out).includes("everdict/everdict"),
  "the resolved branch naming workspace and repository",
);

if (failures.length > 0) {
  console.error("plugin hook check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `PASS plugin hooks: ${Object.keys(hooks).length} hook(s), 10 branches — refusal, allowance and both resolutions`,
);
