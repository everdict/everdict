import { type Score, isMeasured } from "@everdict/contracts";

// ── DOES THE SCORER RESPOND TO A KNOWN-GOOD ANSWER? ──────────────────────────────────────────────────
//
// The campaign certifies the COMPARISON and never the EXAM. `comparable: true` says the two arms were
// measured the same way — same scenarios, same judges, enough trials, no confounded axis. It does not say
// the measurement can produce a pass at all, and there is no other question whose absence costs more: a
// SpreadsheetBench wave ran round after round at 14.3% against a grader whose `answer_position` reader
// raised on 420 of the 912 published positions and had every raise recorded as the agent's wrong answer.
// Feeding it the benchmark's OWN answer workbooks returned `FAIL 3/3` on eight of eight sampled cases.
//
// The question is deliberately NOT "can an agent pass this", which would refuse every hard benchmark and is
// the whole reason a campaign exists. It is "has this scorer ever said yes about this case" — a property of
// the (case, grader) pair, answerable from one scorecard the PLATFORM wrote.
//
// THE COVERAGE IS DERIVED HERE, NOT DECLARED BY THE DRIVER. A frame names one scorecard; what that scorecard
// proves is read out of it (rule `protocol` L3). A boolean the loop sets about its own exam is the
// annotation this repository's whole protocol rule exists to refuse.
export interface ExamProof {
  proven: string[]; // frame scenarios this scorecard measured AND passed
  unproven: string[]; // …and the ones it did not: failed, unmeasured, or never run
  of: number;
}

// A pass is a MEASURED pass. An `unmeasured` row is neither a zero nor a yes — treating it as a failure
// accuses a case nobody scored, and treating it as a proof certifies the very instrument that could not run.
// One passing trial is enough: the question is whether the scorer CAN say yes, not how reliably the subject
// makes it. A case that flakes is still a case whose grader responds, and it is the ordinary shape of the
// exams a campaign is opened to improve.
export function examProofOf(
  scenarios: readonly string[],
  scorecard: { results: ReadonlyArray<{ caseId?: string; scores: readonly Score[] }> },
): ExamProof {
  const passed = new Set<string>();
  for (const row of scorecard.results) {
    if (row.caseId === undefined) continue;
    if (row.scores.filter(isMeasured).some((s) => s.value > 0)) passed.add(row.caseId);
  }
  const proven = scenarios.filter((id) => passed.has(id));
  return { proven, unproven: scenarios.filter((id) => !passed.has(id)), of: scenarios.length };
}
