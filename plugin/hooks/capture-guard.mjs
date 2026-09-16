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
const RECORDING_TOOLS =
  /^mcp__[^_]*everdict[^_]*__(create_knowledge_entry|create_issue|update_issue|set_issue_status|create_comment|create_task|update_task|open_campaign|log_campaign_round|settle_campaign|campaign_decision|publish_checkpoint|request_verification)$/;

let changedCode = false;
let recorded = false;
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
      if (RECORDING_TOOLS.test(block.name)) recorded = true;
    }
  }
}

if (!changedCode || recorded) allow();

const breakGlass = process.env.EVERDICT_BREAK_GLASS?.trim();
if (breakGlass) {
  allow(
    `everdict: capture guard bypassed — break-glass reason: ${breakGlass}. Nothing about this session is on ` +
      `the record in workspace '${workspace}'.`,
  );
}

process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason: [
      `This session changed code but recorded nothing in Everdict (workspace '${workspace}').`,
      "",
      "Record it before stopping — the request this served, and what the work taught:",
      "",
      "1. `create_issue` (or `update_issue` on the one you worked under) — the request and where it stands.",
      "2. `create_knowledge_entry` for each durable claim: `decision` (and what it was chosen against),",
      "   `finding` (a defect's cause, a trap), `convention`. `refs` must name the issue and the repository,",
      "   so the request is one read away from what it produced.",
      "3. If there is genuinely nothing to record, say which of the two it is and record THAT as a `context`",
      "   entry — a refusal someone can read is a decision; silence is not.",
      "",
      "`/everdict:record` walks this. To leave without recording, restart with EVERDICT_BREAK_GLASS='<reason>'.",
    ].join("\n"),
  }),
);
