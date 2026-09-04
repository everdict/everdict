import type {
  CaseAttempt,
  CaseKey,
  CaseResult,
  ExecutionRevision,
  ScorecardRetrySummary,
  VerdictPolicy,
} from "@everdict/contracts";
import { caseKeyOf, encodeCaseKey } from "@everdict/contracts";
import { caseOutcome } from "./case-outcome.js";
import { DEFAULT_VERDICT_POLICY } from "./verdict-policy.js";

// Execution identity (the sibling of `scoring-revision.ts`, which owns the JUDGMENT axis) — the pure
// decisions behind `ScorecardRecord.executions` / `.caseAttempts`.
//
// A retry replaces a case's result IN PLACE, so the current plane mutates exactly the way the score plane
// does on a re-score, and identity has to live somewhere append-only for the same reason: a gate, diff or
// release that cited this record must be able to tell that what it read has moved. Nothing here does I/O
// or decides WHETHER to retry — that is the service's business. These are the answers it needs.

// The key a (caseId, trial) is addressed by everywhere in this file. One spelling, imported, because a
// composite key written twice has already diverged (protocol L3).
function keyOf(v: { caseId: string; trial?: number }): string {
  return encodeCaseKey(caseKeyOf(v.caseId, v.trial));
}

// ── HOW MANY TIMES HAS THIS CASE RUN ─────────────────────────────────────────────────────────────────
//
// One, plus every superseded attempt on the ledger. Stated as a function rather than a stored counter
// because two writers of one number disagree eventually, and the ledger is the thing that has to be right:
// a count that says 3 over two entries is a lie about evidence, where a count derived from the entries can
// only ever be wrong in the direction of the entries themselves.
export function attemptsForCase(attempts: readonly CaseAttempt[] | undefined, key: CaseKey): number {
  if (attempts === undefined) return 1;
  const wanted = keyOf(key);
  return 1 + attempts.filter((a) => keyOf(a) === wanted).length;
}

// Every case that has run more than once, with its count — what a detail view shows next to a case, and
// what makes "this ran 3 times" answerable without loading the heavy ledger entries themselves.
export function attemptCounts(attempts: readonly CaseAttempt[] | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts ?? []) {
    const key = keyOf(attempt);
    counts[key] = (counts[key] ?? 1) + 1;
  }
  return counts;
}

// The light summary a LIST may carry. `cases` counts DISTINCT (case, trial) keys that were re-executed;
// `attempts` counts the superseded executions. They differ whenever one case was retried twice, which is
// exactly the situation a single number would hide.
export function retrySummaryOf(attempts: readonly CaseAttempt[] | undefined): ScorecardRetrySummary {
  const entries = attempts ?? [];
  return { cases: new Set(entries.map(keyOf)).size, attempts: entries.length };
}

// The revision this pass will append. 1-based and strictly increasing over what the record already holds —
// never `executions.length + 1`, which silently re-uses a number if a revision was ever removed.
export function nextExecutionRevision(executions: readonly ExecutionRevision[] | undefined): number {
  let max = 0;
  for (const revision of executions ?? []) if (revision.revision > max) max = revision.revision;
  return max + 1;
}

// ── A RETRY THAT LAUNDERS A VERDICT IS ALLOWED AND IS NEVER SILENT ───────────────────────────────────
//
// The motivating case for in-place retry is an infrastructure death: a case that never produced a
// measurement at all, so replacing it destroys no evidence and the only honest reading of the batch is the
// one where it ran. `unmeasured` and `cancelled` are the same shape — the case reached no verdict, and
// `caseOutcome` already says so.
//
// A case that COMPLETED is different. Re-running a genuine FAIL until it passes is a real thing people
// will want to do for real reasons (a flaky fixture, a rate limit the classifier did not catch), and
// refusing it outright would push them back to forking a whole scorecard — which is the workflow this
// feature exists to end, and which records even less. So it is permitted, and the pass must SAY WHY:
// `reason` is required exactly here, and it lands on the revision where a reader of the record meets it.
//
// The predicate is about the outcome, never about pass/fail: laundering a PASS into a fail deserves the
// same sentence as the other direction, and a policy-less caller must not get the permissive answer by
// omission.
export function retryReasonRequired(
  result: Pick<CaseResult, "scores" | "failure">,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): boolean {
  return caseOutcome(result, policy).status === "completed";
}

// Which of the requested keys need a reason, given the plane they are about to replace. The service asks
// this ONCE and refuses the whole pass — a partial refusal would leave the caller guessing which half ran.
export function keysRequiringReason(
  results: readonly CaseResult[],
  keys: readonly CaseKey[],
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): CaseKey[] {
  const byKey = new Map(results.map((r) => [keyOf(r), r] as const));
  return keys.filter((key) => {
    const current = byKey.get(keyOf(key));
    // A key with no current result cannot be laundering anything — there is no verdict to replace. The
    // service refuses it for a different reason (it is not in this batch at all), which is its call.
    return current !== undefined && retryReasonRequired(current, policy);
  });
}

// ── THE MONOTONIC PROJECTION (protocol L4) ───────────────────────────────────────────────────────────
//
// The newest attempt is the case's answer, and the one it displaced moves to the ledger WHOLE. Two things
// this deliberately does not do:
//
//   · it never DROPS a result. A retried key whose new result is missing keeps the old one, and the
//     revision entry says `replaced: false` — a pass that produced nothing must not be able to empty a
//     case, which would read downstream as a batch that shrank rather than one whose retry failed.
//   · it never reorders `results`. Consumers index the plane positionally in places this file cannot see,
//     and a retry is not a reason for a case to move.
export function supersedeAttempts(input: {
  results: readonly CaseResult[];
  retried: readonly CaseResult[];
  attempts: readonly CaseAttempt[] | undefined;
  revision: number;
  at: string;
  by?: string;
}): { results: CaseResult[]; superseded: CaseAttempt[]; cases: ExecutionRevision["cases"] } {
  const incoming = new Map(input.retried.map((r) => [keyOf(r), r] as const));
  const superseded: CaseAttempt[] = [];
  const cases: ExecutionRevision["cases"] = [];

  const results = input.results.map((current) => {
    const key = keyOf(current);
    const replacement = incoming.get(key);
    if (replacement === undefined) return current;
    incoming.delete(key); // consumed — what is left over never belonged to this plane (below)
    const attempt = attemptsForCase(input.attempts, caseKeyOf(current.caseId, current.trial));
    superseded.push({
      caseId: current.caseId,
      ...(current.trial === undefined ? {} : { trial: current.trial }),
      attempt,
      revision: input.revision,
      supersededAt: input.at,
      ...(input.by === undefined ? {} : { supersededBy: input.by }),
      result: current,
    });
    cases.push({
      caseId: current.caseId,
      ...(current.trial === undefined ? {} : { trial: current.trial }),
      attempt: attempt + 1,
      replaced: true,
    });
    return replacement;
  });

  // A retried result whose key is NOT on the plane is refused rather than appended. It would otherwise add
  // a case to a sealed batch — a dataset the manifest never sealed, decided by a retry — which is the
  // "a fallback is a new semantic decision" failure in rule `suite`, arriving through the back door.
  for (const orphan of incoming.values())
    cases.push({
      caseId: orphan.caseId,
      ...(orphan.trial === undefined ? {} : { trial: orphan.trial }),
      attempt: 1,
      replaced: false,
    });

  return { results, superseded, cases };
}
