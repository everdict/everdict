import type { DelegationBrief, DelegationCriterion, DelegationReference } from "@everdict/contracts";

// ── THE BRIEF EVERDICT ALREADY KNOWS HOW TO WRITE ────────────────────────────────────────────────────
//
// Delegating an issue used to mean typing the issue back out. The record holds the symptom, the reports it
// was filed from, what has been tried, which commits touched it and what the workspace learned last time —
// and the handoff carried whatever prose the supervisor could be bothered to re-type, with none of the
// references and none of the finish line. So the delegate was briefed on a worse version of something the
// system already had, and the parts most likely to be dropped were the ones hardest to notice missing: the
// knowledge from a previous attempt, and the checks somebody would apply to the result.
//
// This is the issue-shaped sibling of `campaignRoundBrief`. Same output contract, same discipline: the brief
// is DERIVED, so a delegate is judged on criteria it was actually given, and a reviewer can see exactly what
// it was told.
//
// ⚠️ WHAT IT DELIBERATELY DOES NOT CARRY. The campaign version excludes held-out ids and scores because a
// delegate that can see the exam aims at it. An issue has no exam, but it has the same failure in a quieter
// form: the RESOLUTION of a related issue reads as "here is the answer", and a delegate handed a previous
// fix will apply that fix. So sibling issues contribute their SUBJECT — this is related, go look — and never
// their resolution note.

export interface IssueDelegationBriefInput {
  issue: {
    identifier: string;
    title: string;
    description?: string;
    status: string;
    // The repository the work lives in, when the issue names one through a commit link or its GitHub half.
    repository?: string;
  };
  // Commits already linked to the issue: where somebody has been, not where the delegate must go.
  commits: { repository: string; sha: string; note?: string }[];
  // Issues this one points at. Subjects only — see the exclusion above.
  related: { identifier: string; title: string; status: string }[];
  // What the workspace knows about the anchors of this task (`get_task_context`). Titles and ids, because a
  // brief that inlined every entry's body would be longer than the work.
  knowledge: { id: string; title: string; kind: string }[];
  // ⚠️ THE THIRD VALUE (rule `protocol` L2). "Nobody has learned anything about this yet" and "the knowledge
  // store could not be read" are the same empty array, and they mean opposite things to a delegate: the first
  // says go ahead, the second says you are about to repeat work somebody already did. So an unreadable store
  // sets this, and the brief SAYS SO — a delegate that knows its context is incomplete can ask; one that was
  // handed silence cannot.
  knowledgeUnavailable?: string;
  // Checks the supervisor will apply beyond the repository's own gates. Free text in, criteria out.
  extraChecks?: string[];
}

// Semantic, not positional — an answer filed against `issue-symptom-gone` still binds when a criterion is
// added above it. `w1..wN` would silently re-number every answer the moment the brief was edited.
const ISSUE_CRITERIA = {
  symptom: "issue-symptom-gone",
  gates: "repo-gates-pass",
  scope: "change-is-scoped",
  reported: "report-filed",
} as const;

export function issueDelegationBrief(input: IssueDelegationBriefInput): DelegationBrief {
  const { issue } = input;

  const goal = `Resolve ${issue.identifier} — ${issue.title}. The issue's own description is the account of the problem; read it before you read the code.`;

  const context: string[] = [];
  if (issue.description !== undefined && issue.description.trim() !== "")
    context.push("## The issue as filed", "", issue.description.trim());

  if (input.commits.length > 0) {
    context.push(
      "",
      "## Commits already linked to this issue",
      "",
      "Somebody has been here. Read these before changing anything — a second fix for a symptom that was",
      "already addressed usually means the first one was misdiagnosed, and that is worth knowing early.",
      "",
      ...input.commits.map((c) => `- \`${c.sha.slice(0, 7)}\` in ${c.repository}${c.note ? ` — ${c.note}` : ""}`),
    );
  }

  if (input.related.length > 0) {
    // Subjects only. A related issue's RESOLUTION would read as the answer, and a delegate handed a previous
    // fix applies that fix — which is how one misdiagnosis becomes two.
    context.push(
      "",
      "## Related issues",
      "",
      "Named so you can look them up, not summarised. How they were resolved is deliberately not here: the",
      "point is that they may be the same problem, and deciding that is part of the work.",
      "",
      ...input.related.map((r) => `- ${r.identifier} (${r.status}) — ${r.title}`),
    );
  }

  if (input.knowledgeUnavailable !== undefined) {
    context.push(
      "",
      "## What this workspace has already learned — UNAVAILABLE",
      "",
      `This brief could not read the workspace's knowledge (${input.knowledgeUnavailable}). That is not the`,
      "same as there being none: work that has already been done on this issue may be invisible to you here.",
      "Say so in your report if you find yourself repeating something.",
    );
  } else if (input.knowledge.length > 0) {
    context.push(
      "",
      "## What this workspace has already learned",
      "",
      ...input.knowledge.map((k) => `- [${k.kind}] ${k.title}`),
    );
  }

  const references: DelegationReference[] = [
    { type: "issue", id: issue.identifier, note: "the request itself — the record this work answers to" },
    ...input.knowledge.map(
      (k): DelegationReference => ({ type: "knowledge", id: k.id, note: "what the workspace already learned" }),
    ),
  ];

  const constraints = [
    "Change the least that resolves the issue. A diff that also tidies neighbouring code cannot be reviewed " +
      "as a fix — the reviewer has to separate the two by reading, and usually will not.",
    "The repository's own conventions win over your preferences. Read its CLAUDE.md or AGENTS.md first.",
    "Do not close, resolve or comment on the issue in Everdict. You report; the orchestrator decides what the " +
      "report means. A delegate that records its own verdict is grading its own exam.",
    "If the issue turns out to be misdiagnosed, say so in your report and stop. A confident fix for the wrong " +
      "problem costs more than an honest `not_met`.",
  ];

  const doneWhen: DelegationCriterion[] = [
    {
      id: ISSUE_CRITERIA.symptom,
      statement: `The symptom ${issue.identifier} describes no longer reproduces, and you can say how you checked. If you could not reproduce it in the first place, that is a \`not_met\` with \`needs_information\`, not a pass.`,
    },
    {
      id: ISSUE_CRITERIA.gates,
      statement:
        "The repository's own build, lint and tests pass, and you name each command and its numbers in " +
        "`gateRuns`. A gate that was already failing before you started is reported with its baseline, not hidden.",
    },
    {
      id: ISSUE_CRITERIA.scope,
      statement: "The diff changes one thing, and you can say in one sentence what that thing is.",
    },
    {
      id: ISSUE_CRITERIA.reported,
      statement:
        "REPORT.json exists, answers every criterion here by id, and its `learned` says what the next person " +
        "would want to know — including if that is 'the obvious approach does not work, because…'.",
    },
    ...(input.extraChecks ?? []).map((statement, i): DelegationCriterion => ({ id: `supervisor-${i + 1}`, statement })),
  ];

  return {
    goal,
    ...(context.length > 0 ? { context: context.join("\n") } : {}),
    references,
    constraints,
    doneWhen,
  };
}
