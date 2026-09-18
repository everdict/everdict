#!/usr/bin/env node
// Stop — a session that changed code and recorded nothing in Everdict is refused ONCE.
//
// Why a refusal rather than a reminder: the system-of-record decision measured what guidance achieves
// (`docs/architecture/development-system-of-record.md`, "What was rejected" — "a skill is advisory; a policy
// that must hold needs something that refuses"). A coding session on this machine on 2026-09-16 fixed a
// defect end to end and recorded nothing; nothing asked it to.
//
// Three properties keep the refusal from becoming a trap:
//   · it fires ONCE — `stop_hook_active` is the harness's own loop guard, and a second pass lets the session end;
//   · it fires only where the repository OPTED IN — no `.everdict/workspace` (or EVERDICT_WORKSPACE) means no
//     refusal, because a session that cannot name a workspace has nowhere to record and being told twice is noise;
//   · it has a BREAK-GLASS — `EVERDICT_BREAK_GLASS='<reason>'` lets the session end and reports the reason,
//     so the escape is visible afterwards rather than silent.
//
// The evidence is the transcript, which is the only place a hook can see what the session actually did.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const stdin = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
  });
  process.stdin.on("end", () => resolve(buf));
});

const allow = (systemMessage) => {
  process.stdout.write(systemMessage ? JSON.stringify({ systemMessage }) : "{}");
  process.exit(0);
};

let input = {};
try {
  input = JSON.parse(stdin || "{}");
} catch {
  process.exit(0);
}

// The harness sets this on the pass that follows a block. Refusing again here is how a Stop hook becomes an
// infinite loop, so this is the first thing read.
if (input.stop_hook_active === true) allow();

const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
let root;
try {
  root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  root = undefined;
}
const workspaceFile = root ? path.join(root, ".everdict", "workspace") : undefined;
const workspace =
  process.env.EVERDICT_WORKSPACE?.trim() ||
  (workspaceFile && existsSync(workspaceFile) ? readFileSync(workspaceFile, "utf8").trim() : "");
if (!workspace) allow();

// What the session did, read from its own transcript. Unparsable lines are skipped rather than fatal: a
// partial read can only UNDER-report, and under-reporting a code change means not refusing — the safe
// direction for a guard that blocks.
const CODE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Asking the workspace what it already knows is the OTHER half, and the one a model skips most reliably:
// SRA-Bench measured weak need awareness — skills were loaded on roughly the same share of tasks whether or
// not the model was failing without them. A session that changed code having never asked is refused for that
// reason, separately from having recorded nothing, because they are different failures with different repairs.
const RETRIEVAL_TOOLS = /^mcp__[^_]*everdict[^_]*__(get_task_context|list_knowledge_entries|get_knowledge_entry)$/;
// …and the half of the retrieval record only the session can write. The assembly files what it ANSWERED;
// whether any of it was USED is knowable nowhere else, and it is the measurement that decides every later
// question about this layer (is an index worth building, which entries are dead weight, does curation help).
// Asked for at session start, so a session that retrieved and then said nothing about it is a gap with an
// owner rather than an oversight.
// The tool that files it: the platform resolves every cited entry and REFUSES an id it cannot, which a raw
// file write cannot do. A generic `write_file` at the same path still counts — a session that wrote the file
// before this tool existed accounted for itself, and refusing it would punish the older, honest shape.
const USE_TOOL = /^mcp__[^_]*everdict[^_]*__record_retrieval_use$/;
const WRITE_TOOL = /^mcp__[^_]*everdict[^_]*__write_file$/;
const USED_PATH = /^knowledge\/retrievals\/[^/]+\/[^/]+\/used\.json$/;
// ── WHAT A RECORD ANSWERS, AND WHY ONE KIND IS NOT ENOUGH ───────────────────────────────────────────
//
// A person who asked for work wants four things in order: what problem · what method · what result · WHAT
// VERIFICATION. Issues and knowledge answer the first and, between them, most of the second and third. None
// of them answers the fourth, because none of them carries a number: `gateRuns` with exit codes and metrics
// live on a change ROUND and nowhere else.
//
// ⚠️ MEASURED 2026-09-18, and this split exists because of it. A session spent hours on nine commits across
// five packages, filed five issues, closed them with resolution notes and wrote four knowledge entries — and
// `lint 0 · test 51/51 · build 51/51`, eight scanners and thirteen neutralizations seen red all ended up in
// git commit bodies, outside Everdict, unqueryable and uncomparable. The guard was satisfied by the first
// `create_issue` and never asked for the rest. It was not a lazy session; it was a guard asking a weaker
// question than the one it exists to force.
const RECORDING_TOOLS =
  /^mcp__[^_]*everdict[^_]*__(create_knowledge_entry|create_issue|update_issue|set_issue_status|create_comment|create_task|update_task|open_campaign|log_campaign_round|settle_campaign|campaign_decision|publish_checkpoint|request_verification)$/;

// The CHANGE grade — the unit a code change belongs to, and the only record that carries measurements.
// ⚠️ These three were absent from RECORDING_TOOLS entirely, so a session that ran the change loop perfectly
// was refused for having "recorded nothing", while one that only touched an issue passed. A guard that does
// not recognise the grade it guards is the first thing to fix.
const ROUND_TOOLS = /^mcp__[^_]*everdict[^_]*__log_change_round$/;
const CHANGE_GRADE_TOOLS = /^mcp__[^_]*everdict[^_]*__(open_change_campaign|log_change_round|close_change_campaign)$/;

let changedCode = false;
let recorded = false;
let loggedRound = false;
let retrieved = false;
let filedUsed = false;
const transcript = typeof input.transcript_path === "string" ? input.transcript_path : undefined;
if (transcript && existsSync(transcript)) {
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      if (CODE_TOOLS.has(block.name)) changedCode = true;
      else if (block.name === "Bash" && /\bgit\s+commit\b/.test(String(block.input?.command ?? ""))) changedCode = true;
      if (RECORDING_TOOLS.test(block.name) || CHANGE_GRADE_TOOLS.test(block.name)) recorded = true;
      if (ROUND_TOOLS.test(block.name)) loggedRound = true;
      if (RETRIEVAL_TOOLS.test(block.name)) retrieved = true;
      if (USE_TOOL.test(block.name)) filedUsed = true;
      else if (WRITE_TOOL.test(block.name) && USED_PATH.test(String(block.input?.path ?? ""))) filedUsed = true;
    }
  }
}

// A session that never retrieved owes no `used.json` — there is nothing to report using. The obligation is
// created by the answer, not by the question.
const owesUsed = retrieved && !filedUsed;
// A session that changed code owes the quantitative record too. `recorded` stays required — the round says
// what was run, and the issue and the knowledge say what was asked and what it taught, which a round does not.
const owesRound = changedCode && !loggedRound;
if (!changedCode || (recorded && retrieved && !owesUsed && !owesRound)) allow();

const breakGlass = process.env.EVERDICT_BREAK_GLASS?.trim();
if (breakGlass) {
  allow(
    `everdict: capture guard bypassed — break-glass reason: ${breakGlass}. This session's work is not fully ` +
      `on the record in workspace '${workspace}'.`,
  );
}

process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason: [
      ...(retrieved
        ? []
        : [
            `This session changed code without asking what workspace '${workspace}' already knows.`,
            "",
            "Run the anchored call the session opened with — `get_task_context` with the repository (and the",
            "issue, harness or dataset this work concerns). A convention already decided, a finding that already",
            "names this trap, a decision you are about to re-argue: reading them is cheaper than rediscovering",
            "them. Then say, in what you record, which entries you were given and which ones you used.",
            "",
          ]),
      ...(recorded
        ? []
        : [
            `This session changed code but recorded nothing in Everdict (workspace '${workspace}').`,
            "",
            "Record it before stopping — the request this served, and what the work taught:",
            "",
            "1. `create_issue` (or `update_issue` on the one you worked under) — the request and where it stands.",
            "2. `create_knowledge_entry` for each durable claim: `decision` (and what it was chosen against),",
            "   `finding` (a defect's cause, a trap), `convention`. `refs` must name the issue and the repository —",
            '   and `{type:"knowledge", key}` for every entry you built on, or repetition reads as corroboration.',
            '3. `publish_checkpoint` (`role: "executor"`) for your judgement: what you claimed, with the evidence',
            "   you can point at; anything you cannot goes in `hypotheses`.",
            "4. If there is genuinely nothing to record, say which of the two it is and record THAT as a `context`",
            "   entry — a refusal someone can read is a decision; silence is not.",
            "",
          ]),
      ...(owesRound
        ? [
            `This session changed code and logged no round, so what it RAN is not on the record in workspace '${workspace}'.`,
            "",
            "Issues and knowledge answer what was asked and what it taught. Neither carries a measurement, and a",
            "measurement is what the person who asked for the work is actually short of: they want what problem,",
            "what method, what result, and WHAT VERIFICATION. Only a round holds the fourth.",
            "",
            "`/everdict:campaign` opens the request and the campaign this work belongs to. Then:",
            "",
            "    log_change_round { id, hypothesis, changes:[{repository, commits:[{sha, message}]}],",
            "                       gateRuns:[{id, command, exitCode, metrics:[{name, value}]}],",
            "                       answers:[{criterionId, answer, how, gateRunIds, detail}], learned }",
            "",
            'Carry the gates WITH THEIR NUMBERS — `tests.passed 4279`, not "the suite is green" — because only',
            "the number can be compared to the next round or disagreed with. An `observed` answer must cite a",
            "gate run by id; one that names no measurement is an assertion wearing the other word.",
            "",
            "⚠️ Declare the criteria BEFORE the work where you can. A criterion written afterwards describes the",
            "outcome instead of judging it, and the campaign says so when you open one.",
            "",
            "Nothing to judge — a typo, a comment, a rename? Say so in the round's `hypothesis` and answer the",
            "criteria honestly. A round that records a small change is cheap; a change with no round is invisible.",
            "",
          ]
        : []),
      ...(owesUsed
        ? [
            "This session asked what the workspace knows and never said what it used.",
            "",
            "The assembly filed what it ANSWERED — its path came back in the `receipt` of your",
            "`get_task_context` call. Beside it, write the half only you can know:",
            "",
            "    record_retrieval_use  { assembly_path: <the receipt.path you got back>,",
            '                            used: ["<entry id>", …], outcome: "what the work did with it" }',
            "",
            "An empty `used` is a real answer and worth writing: it says the workspace had nothing for this work,",
            "which is the measurement that decides whether the knowledge layer is earning its keep.",
            "",
          ]
        : []),
      "`/everdict:campaign` and `/everdict:record` walk this. To leave without it, restart with",
      "EVERDICT_BREAK_GLASS='<reason>' — the reason is reported instead of the refusal.",
    ].join("\n"),
  }),
);
