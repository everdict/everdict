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
  toolUse("mcp__everdict__get_task_context", { refs: [{ type: "repository", key: "acme/widget" }] }),
  toolUse("mcp__everdict__create_knowledge_entry", { kind: "finding" }),
  toolUse("mcp__everdict__write_file", { path: "knowledge/retrievals/2026-09-16/s-1/used.json" }),
  toolUse("mcp__everdict__log_change_round", { id: "c-1", hypothesis: "h" }),
]);
const COMMITTED_ONLY = transcript("committed-only", [toolUse("Bash", { command: "git commit -m x" })]);
// A session whose record is its JUDGEMENT rather than a knowledge entry has recorded (the ownership
// protocol's executor claim, `docs/architecture/change-campaign-spec.md`). Its own branch, because the
// recording vocabulary is a regex and a regex that silently stops matching one name looks like a quiet session.
const CHANGED_AND_JUDGED = transcript("changed-and-judged", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__get_task_context", { refs: [{ type: "repository", key: "acme/widget" }] }),
  toolUse("mcp__everdict__publish_checkpoint", { role: "executor" }),
  toolUse("mcp__everdict__write_file", { path: "knowledge/retrievals/2026-09-16/s-2/used.json" }),
  toolUse("mcp__everdict__log_change_round", { id: "c-1", hypothesis: "h" }),
]);
// Recorded, but never ASKED. The two halves fail differently and are repaired differently, so the refusal
// has to say which one is missing — a session told "record something" when it already did learns nothing.
const RECORDED_NOT_RETRIEVED = transcript("recorded-not-retrieved", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__create_knowledge_entry", { kind: "finding" }),
]);
// Asked, recorded, and never said what any of it was FOR. The obligation is created by the answer: a session
// that never retrieved owes no `used.json`, which is why the read-only and never-retrieved branches stay green.
const RETRIEVED_NO_USED = transcript("retrieved-no-used", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__get_task_context", { refs: [{ type: "repository", key: "acme/widget" }] }),
  toolUse("mcp__everdict__create_knowledge_entry", { kind: "finding" }),
]);
// The dedicated tool is the way now — the platform resolves the citations a raw write cannot check — and the
// old shape still counts, because a session that wrote the file before the tool existed accounted for itself.
const USED_BY_TOOL = transcript("used-by-tool", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__get_task_context", { refs: [{ type: "repository", key: "acme/widget" }] }),
  toolUse("mcp__everdict__create_knowledge_entry", { kind: "finding" }),
  toolUse("mcp__everdict__record_retrieval_use", { assembly_path: "knowledge/retrievals/d/s/assembly-x.json" }),
  toolUse("mcp__everdict__log_change_round", { id: "c-1", hypothesis: "h" }),
]);
const USED_FILED = transcript("used-filed", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__get_task_context", { refs: [{ type: "repository", key: "acme/widget" }] }),
  toolUse("mcp__everdict__create_knowledge_entry", { kind: "finding" }),
  toolUse("mcp__everdict__write_file", { path: "knowledge/retrievals/2026-09-16/s-42/used.json" }),
  toolUse("mcp__everdict__log_change_round", { id: "c-1", hypothesis: "h" }),
]);
// ⚠️ THE BRANCH THIS FILE EXISTS FOR AFTER 2026-09-18. A session that did everything the guard used to ask —
// asked the workspace, filed issues, wrote knowledge, accounted for what it used — and logged NO ROUND. It
// looks like a diligent session from every angle, and what it RAN is nowhere in Everdict. That is what
// happened for hours on this repository before the rule existed.
const RECORDED_BUT_NO_ROUND = transcript("recorded-no-round", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__get_task_context", { refs: [{ type: "repository", key: "acme/widget" }] }),
  toolUse("mcp__everdict__create_issue", { title: "the request" }),
  toolUse("mcp__everdict__create_knowledge_entry", { kind: "finding" }),
  toolUse("mcp__everdict__record_retrieval_use", { assembly_path: "knowledge/retrievals/d/s/assembly-x.json" }),
]);
// The change grade is the record. Nothing else in the transcript — no knowledge entry, no issue — because the
// point is that these three tools were absent from the recording vocabulary entirely: a session that ran the
// change loop perfectly was refused for having "recorded nothing".
const CHANGE_GRADE_ONLY = transcript("change-grade-only", [
  toolUse("Edit", { file_path: "/x/y.ts" }),
  toolUse("mcp__everdict__get_task_context", { refs: [{ type: "repository", key: "acme/widget" }] }),
  toolUse("mcp__everdict__open_change_campaign", { issue_id: "i-1" }),
  toolUse("mcp__everdict__log_change_round", { id: "c-1", hypothesis: "h" }),
  toolUse("mcp__everdict__record_retrieval_use", { assembly_path: "knowledge/retrievals/d/s/assembly-x.json" }),
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
  "capture/recorded everything EXCEPT a round → blocked, naming what it RAN",
  run(hooks.capture, { cwd: work, transcript_path: RECORDED_BUT_NO_ROUND }, { EVERDICT_WORKSPACE: "acme" }),
  (out) =>
    blocks(out) &&
    out.reason.includes("logged no round") &&
    out.reason.includes("log_change_round") &&
    out.reason.includes("gateRuns") &&
    // and it must NOT accuse the session of the things it actually did
    !out.reason.includes("recorded nothing in Everdict") &&
    !out.reason.includes("without asking what workspace"),
  "a block about the ROUND only, telling the session what a round needs",
);
check(
  "capture/the change grade IS recording — the three tools that were missing from the vocabulary",
  run(hooks.capture, { cwd: work, transcript_path: CHANGE_GRADE_ONLY }, { EVERDICT_WORKSPACE: "acme" }),
  allows,
  "no decision — a session that ran the change loop recorded, and used to be refused for recording nothing",
);
check(
  "capture/recorded but never asked → blocked, naming the RETRIEVAL half",
  run(hooks.capture, { cwd: work, transcript_path: RECORDED_NOT_RETRIEVED }, { EVERDICT_WORKSPACE: "acme" }),
  (out) =>
    blocks(out) && out.reason.includes("without asking what workspace") && !out.reason.includes("recorded nothing"),
  "a block about retrieval only — the recording half was satisfied",
);
check(
  "capture/retrieved but never said what it used → blocked, naming THAT half",
  run(hooks.capture, { cwd: work, transcript_path: RETRIEVED_NO_USED }, { EVERDICT_WORKSPACE: "acme" }),
  (out) => blocks(out) && out.reason.includes("never said what it used"),
  "a block about the used half only",
);
check(
  "capture/accounted for with record_retrieval_use → allowed",
  run(hooks.capture, { cwd: work, transcript_path: USED_BY_TOOL }, { EVERDICT_WORKSPACE: "acme" }),
  allows,
  "no decision — the session filed its account through the tool that checks it",
);
check(
  "capture/used.json filed → allowed",
  run(hooks.capture, { cwd: work, transcript_path: USED_FILED }, { EVERDICT_WORKSPACE: "acme" }),
  allows,
  "no decision — both halves of the retrieval record exist",
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
check(
  // Retrieval here answers about the entities a task NAMES, so handing over a ready call with the anchor
  // already in it is the difference between context and none. The argument name is part of the contract:
  // the tool takes `refs`, and an emitted `anchors` would be a call the session has to repair.
  "session-start/hands over an anchored get_task_context call",
  run(hooks.sessionStart, { cwd: root }, { EVERDICT_WORKSPACE: "acme" }),
  (out) => context(out).includes('get_task_context {"refs":[{"type":"repository","key":"everdict/everdict"}]}'),
  "the exact call, with the repository anchor and the `refs` argument",
);

if (failures.length > 0) {
  console.error("plugin hook check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `PASS plugin hooks: ${Object.keys(hooks).length} hook(s), 15 branches — three refusals, both ways of accounting, the resolutions and the anchored call`,
);
