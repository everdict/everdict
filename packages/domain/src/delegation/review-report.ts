import type { ChangeCriterion, DelegateCriterionEcho, DelegateReport, DelegationBrief } from "@everdict/contracts";

// ── DOES THIS REPORT ANSWER THE BRIEF IT WAS GIVEN? ──────────────────────────────────────────────────
//
// The review seam. A supervisor reading a delegate's report is deciding whether to accept work, and the
// question that comes BEFORE "is this good?" is "is this even an answer?" — because a report that quietly
// skips two of five criteria reads exactly like one that met three, and the difference is invisible at a
// glance in prose.
//
// This function does not judge the work. It judges whether the report CORRESPONDS to the brief, which is the
// part a machine can settle and a tired reader cannot. Everything it returns is a fact about the pairing:
// which criteria nobody answered, which answers name a criterion that was never asked for, and which
// `observed` answers cite a measurement that is not in the report.
//
// ⚠️ IT RETURNS FINDINGS RATHER THAN THROWING. A report that does not fully correspond is still worth
// reading — a delegate blocked at criterion two has told the supervisor something important — so the caller
// decides what an incomplete correspondence means. Throwing here would make "you did not answer everything"
// and "your report is malformed" the same event, and only one of them is the delegate's fault.

export interface DelegateReportReview {
  // Criterion ids in the brief that no answer names. The list a supervisor actually acts on.
  unanswered: string[];
  // Answers naming a criterion the brief does not contain. Usually a delegate answering an older brief, which
  // matters precisely because the answer LOOKS valid until someone checks the id against the current one.
  unknownCriteria: string[];
  // Ids answered more than once. Two verdicts for one criterion is not a stronger claim, it is no claim —
  // there is no rule for choosing between them, so neither can be counted.
  duplicated: string[];
  // `observed` answers whose `gateRunIds` name a run the report does not carry. An observation that cites a
  // measurement nobody can find is an assertion wearing the other word — the same law the campaign lane
  // enforces on its own rounds, applied where the claim is made instead of where it is filed.
  danglingGateRuns: { criterionId: string; gateRunIds: string[] }[];
  // True when every criterion has exactly one answer and every citation resolves. Not "the work is good".
  answersTheBrief: boolean;
}

export function reviewDelegateReport(
  brief: Pick<DelegationBrief, "doneWhen">,
  report: Pick<DelegateReport, "answers" | "gateRuns">,
): DelegateReportReview {
  const asked = new Set(brief.doneWhen.map((c) => c.id));
  const gateRunIds = new Set(report.gateRuns.map((g) => g.id));

  const seen = new Map<string, number>();
  for (const answer of report.answers) seen.set(answer.criterionId, (seen.get(answer.criterionId) ?? 0) + 1);

  const unanswered = brief.doneWhen.filter((c) => !seen.has(c.id)).map((c) => c.id);
  const unknownCriteria = [...seen.keys()].filter((id) => !asked.has(id)).sort();
  const duplicated = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  const danglingGateRuns: DelegateReportReview["danglingGateRuns"] = [];
  for (const answer of report.answers) {
    if (answer.how !== "observed") continue;
    const missing = answer.gateRunIds.filter((id) => !gateRunIds.has(id));
    if (missing.length > 0) danglingGateRuns.push({ criterionId: answer.criterionId, gateRunIds: missing });
  }

  return {
    unanswered,
    unknownCriteria,
    duplicated,
    danglingGateRuns,
    answersTheBrief:
      unanswered.length === 0 &&
      unknownCriteria.length === 0 &&
      duplicated.length === 0 &&
      danglingGateRuns.length === 0,
  };
}

// The one-line summary a supervisor sees before deciding to read further. Derived from the review rather than
// counted again at the call site: two places counting "how many met" is two places that can disagree about
// what `not_run` is.
export interface DelegateReportTally {
  total: number;
  met: number;
  notMet: number;
  notRun: number;
  unanswered: number;
}

export function tallyDelegateReport(
  brief: Pick<DelegationBrief, "doneWhen">,
  report: Pick<DelegateReport, "answers" | "gateRuns">,
): DelegateReportTally {
  const asked = new Set(brief.doneWhen.map((c) => c.id));
  // Only answers to criteria that were actually asked for are counted — an answer to an unknown id is a
  // finding (`unknownCriteria`), never a contribution to the score.
  const counted = report.answers.filter((a) => asked.has(a.criterionId));
  return {
    total: brief.doneWhen.length,
    met: counted.filter((a) => a.answer === "met").length,
    notMet: counted.filter((a) => a.answer === "not_met").length,
    notRun: counted.filter((a) => a.answer === "not_run").length,
    unanswered: reviewDelegateReport(brief, report).unanswered.length,
  };
}

// ── THE JOIN THE CHANGE GRADE LANDS A ROUND ON (DEFAUL-38) ───────────────────────────────────────────
//
// `reviewDelegateReport` answers "does this report answer the brief it was given". This answers the next
// question, which is the one a round is made of: what did the delegate say about each criterion THE CAMPAIGN
// DECLARED? The two are different id spaces on purpose — a delegate briefed on an older list, or on a subset,
// is the case that has to stay visible — and the join is by criterion id because that is the only key both
// sides mint at their own source.
//
// ⚠️ EVERY DECLARED CRITERION GETS AN ENTRY. A skipped one is `unanswered`, in declaration order, so "it
// skipped two of five" is a pair of rows rather than two rows that are not there. That absence is the exact
// thing plugin/commands/delegate.md §8 says reads identically to success.
export interface DelegateRoundJoin {
  reported: DelegateCriterionEcho[];
  // Answers naming a criterion this campaign never declared — counted nowhere, dropped nowhere.
  unknownCriteria: string[];
  // Declared ids the report answered more than once. Two verdicts for one criterion is not a stronger claim,
  // it is no claim: there is no rule for choosing between them, so the caller refuses rather than picks.
  duplicated: string[];
}

export function joinDelegateReportToCriteria(
  criteria: Pick<ChangeCriterion, "id">[],
  report: Pick<DelegateReport, "answers">,
): DelegateRoundJoin {
  const declared = new Set(criteria.map((c) => c.id));
  const byCriterion = new Map<string, DelegateReport["answers"]>();
  for (const answer of report.answers) {
    const seen = byCriterion.get(answer.criterionId);
    if (seen) seen.push(answer);
    else byCriterion.set(answer.criterionId, [answer]);
  }

  const reported: DelegateCriterionEcho[] = criteria.map((criterion) => {
    const answers = byCriterion.get(criterion.id);
    const answer = answers?.[0];
    if (answer === undefined) return { kind: "unanswered", criterionId: criterion.id };
    return {
      kind: "answered",
      criterionId: criterion.id,
      answer: answer.answer,
      how: answer.how,
      ...(answer.answer !== "met" ? { reason: answer.reason } : {}),
      ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
    };
  });

  return {
    reported,
    unknownCriteria: [...byCriterion.keys()].filter((id) => !declared.has(id)).sort(),
    duplicated: [...byCriterion.entries()]
      .filter(([id, answers]) => declared.has(id) && answers.length > 1)
      .map(([id]) => id)
      .sort(),
  };
}
