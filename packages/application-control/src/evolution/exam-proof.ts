import type { CaseResult, VerdictPolicy } from "@everdict/contracts";
import { caseVerdict } from "@everdict/domain";

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

// ⚠️ A PASS IS THE PLATFORM'S PASS, AND FOR ONE RELEASE IT WAS `value > 0`.
//
// The first version asked `row.scores.filter(isMeasured).some((s) => s.value > 0)`, which reads as "some
// measurement said something positive" and is not the same question. `value` is a MAGNITUDE, and three of
// the graders this repository ships emit one on every run that happened at all:
//
//     steps    → { metric: "tool_calls", value: <tool calls> }
//     cost     → { metric: "usd",        value: <usd> }
//     latency  → { metric: "span",       value: <ms> }
//
// None carries `pass`, none is a claim about correctness, and each is positive the moment the agent did
// anything. So a frame whose harness declared any of them had every case that RAN counted as proven — the
// positive control certifying precisely the dead exam it was built to expose, and doing it most reliably
// on the wave that motivated it, because that wave measured cost. A categorical metric reaches the same
// end without them: `value` is documented as the ordinal key (bronze<silver<gold ⇒ 1<2<3), so the worst
// tier scores 1 and reads as proof.
//
// `caseVerdict` is the decision the rest of the platform already stands on — it ignores any score that does
// not carry an explicit `pass`, ranks the ones that do by authority (ground_truth → objective → judge),
// applies the batch's own stamped policy, and returns UNDEFINED when nothing decided. Re-deciding "did this
// pass" beside it is L3's predicate-written-twice, and this is what the second copy diverged into.
//
// A pass is a MEASURED pass. An `unmeasured` row is neither a zero nor a yes — treating it as a failure
// accuses a case nobody scored, and treating it as a proof certifies the very instrument that could not run.
// `caseVerdict`'s `undefined` covers both that and "no pass-deciding grader ran here", and both belong in
// `unproven`: not proven is the honest reading, and the caller's refusal message says the coverage is
// unproven rather than that the exam is broken.
//
// One passing trial is enough: the question is whether the scorer CAN say yes, not how reliably the subject
// makes it. A case that flakes is still a case whose grader responds, and it is the ordinary shape of the
// exams a campaign is opened to improve.
export function examProofOf(
  scenarios: readonly string[],
  scorecard: {
    results: ReadonlyArray<{ caseId?: string; scores: CaseResult["scores"]; failure?: CaseResult["failure"] }>;
  },
  policy?: VerdictPolicy,
): ExamProof {
  const passed = new Set<string>();
  for (const row of scorecard.results) {
    if (row.caseId === undefined) continue;
    if (caseVerdict(row, policy) === true) passed.add(row.caseId);
  }
  const proven = scenarios.filter((id) => passed.has(id));
  return { proven, unproven: scenarios.filter((id) => !passed.has(id)), of: scenarios.length };
}
