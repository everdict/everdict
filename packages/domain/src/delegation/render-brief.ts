import type { DelegationBrief } from "@everdict/contracts";

// The file the delegate writes its report into. Named here because this renderer is what TELLS the delegate
// the name, and the session service reads the same constant back — one spelling, or the delegate files a
// report at a path nobody looks at.
export const DELEGATE_REPORT_FILE = "REPORT.json";

// The delegation brief, rendered as the markdown the delegate actually reads. ONE renderer, because the brief
// reaches its reader through three doors — the file seeded into the sandbox, the marker sealed on the session's
// trajectory, and (later) whatever surface shows a delegation — and a handoff that reads differently depending
// on where you look at it is not a handoff anyone can audit.
//
// Sections are omitted when empty (the same hide-empty discipline the detail views use): a brief with no
// constraints must not tell the delegate there is a constraints section it should be looking for.
export function renderDelegationBrief(brief: DelegationBrief): string {
  const lines: string[] = ["# Delegation brief", "", "## Goal", brief.goal.trim()];
  if (brief.context !== undefined && brief.context.trim() !== "") {
    lines.push("", "## Context", brief.context.trim());
  }
  if (brief.references.length > 0) {
    lines.push("", "## References");
    for (const ref of brief.references) {
      const version = ref.version !== undefined ? `@${ref.version}` : "";
      const note = ref.note !== undefined && ref.note.trim() !== "" ? ` — ${ref.note.trim()}` : "";
      lines.push(`- ${ref.type} \`${ref.id}${version}\`${note}`);
    }
  }
  if (brief.constraints.length > 0) {
    lines.push("", "## Constraints");
    for (const c of brief.constraints) lines.push(`- ${c}`);
  }
  if (brief.doneWhen.length > 0) {
    // ⚠️ THE ID IS RENDERED, and it is not decoration. This is the only place the delegate learns what to call
    // each check, and its report answers them BY ID — a finish line the delegate can read but not name is one
    // it can only answer in prose, which is the state this whole handoff exists to leave behind.
    lines.push("", "## Done when");
    lines.push("", "Answer each of these by its id when you report back.", "");
    for (const d of brief.doneWhen) lines.push(`- \`${d.id}\` — ${d.statement}`);
  }

  // ── HOW TO REPORT BACK ─────────────────────────────────────────────────────────────────────────────
  //
  // The delegate has no channel to the control plane — no tool surface, no credential — so a file in the
  // working directory we already own is the only place it can put something we will reliably find. The brief
  // came in as a file; the report leaves as one, and this section is where the delegate learns that.
  //
  // It is rendered ALWAYS, even for a brief with no `doneWhen`: a delegate that finishes without saying what
  // it did leaves a supervisor to reconstruct the work from a trace, and the commonest reason for that is
  // simply never having been told there was somewhere to write it.
  lines.push(
    "",
    "## Reporting back",
    "",
    `When you are finished, write \`${DELEGATE_REPORT_FILE}\` in this directory. It is how the orchestrator`,
    "learns what you did — there is no other channel, and a turn that ends without it reads as work nobody",
    "can account for.",
    "",
    "```json",
    "{",
    '  "summary": "what you did, in a few sentences",',
    '  "answers": [',
    '    { "criterionId": "<an id from Done when>", "answer": "met", "how": "observed",',
    '      "gateRunIds": ["g-tests"], "detail": "what you ran and what it said" },',
    '    { "criterionId": "<another>", "answer": "not_met", "reason": "needs_environment",',
    '      "how": "asserted", "gateRunIds": [], "detail": "why you could not" }',
    "  ],",
    '  "gateRuns": [{ "id": "g-tests", "command": "npm test", "exitCode": 0,',
    '                 "metrics": [{ "name": "tests.passed", "value": 128 }] }],',
    '  "changes": [{ "repository": "owner/name", "commits": [{ "sha": "abc1234", "message": "..." }] }],',
    '  "learned": "what this taught that the next person would want to know",',
    '  "blockers": []',
    "}",
    "```",
    "",
    "Rules that matter:",
    "",
    "- Answer EVERY id under Done when. A criterion you skipped is reported as unanswered, which reads worse",
    "  than an honest `not_met` — being unable to meet one is ordinary, and hiding it is not.",
    "- `answer` is `met` · `not_met` · `not_run`; the last two carry a `reason`:",
    "  `attempted_and_failed` · `needs_information` · `needs_environment` · `blocked_elsewhere` · `descoped`.",
    "- `how` is `observed` only when a command ran and you can name it in `gateRuns`. An observation citing a",
    "  measurement that is not in the file is an assertion wearing the other word, and it is checked.",
    "- Report honestly. Answering the brief is not the same as meeting it, and nothing here rewards a `met`",
    "  you cannot support — the orchestrator reviews the answers against what you ran.",
    "- COMMIT what you changed before you write the report. Your working directory dies with this session, and",
    "  a commit is what lets the orchestrator take the work out as a patch — uncommitted changes are lost the",
    "  moment the container goes, whatever your report says about them.",
    "",
    "### If you need a decision that is not yours to make",
    "",
    "Some things are not coding calls — where a new screen lives, which of two readings of the request is the",
    "right one, whether to widen the scope. **Do not guess them.** Put them in `questions` and STOP:",
    "",
    "```json",
    '  "questions": [',
    '    { "id": "where-it-lives", "question": "A new screen, a field on the existing sheet, or a FAB?",',
    '      "why": "nothing in the app has this entry point yet, and picking one is a navigation decision",',
    '      "options": ["new screen", "field on ExpenseFormSheet", "FAB on the settlement tab"] }',
    "  ]",
    "```",
    "",
    "A report with questions leaves you `awaiting` rather than `completed`, which is how the orchestrator sees",
    "that you are waiting on it rather than done — and the answer comes back as your next task. `why` is",
    "required: a question without it sends the orchestrator back into the work to reconstruct what you already",
    "knew. Narrow it to `options` when you can; you have read the code and it has not.",
  );

  return `${lines.join("\n")}\n`;
}
