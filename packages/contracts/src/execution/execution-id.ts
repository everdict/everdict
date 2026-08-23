// ── WHICH ID IS THIS? (arch-review 63, the stated root cause) ────────────────────────────────────────
//
// One `string` spells a child's database row id, a logical execution id, a runtime runId, an attempt id and
// an external object id. So `c.id` and `c.executionId` are interchangeable to the compiler, and the batch
// recovery read the physical attempt ledger — keyed by the execution — using the row id. It matched nothing
// for every child of every batch, so recovery adopted nothing and re-dispatched cases whose Jobs may still
// have been running. Nothing failed; a lookup simply always answered empty.
//
// It read as CONSISTENT, which is the part worth remembering: the verifier lookup beside it used the same
// wrong string, under a comment approving them for matching. Being consistent with the wrong string is
// exactly as broken as being inconsistent and looks considerably better.
//
// The brand makes the question the compiler's. It is deliberately NOT on `RunRecord.executionId`: branding a
// schema field ripples into every record literal in the repository and proves nothing extra, because the
// place the confusion happens is the CALL. The ledger's parameters take the brand, so the only way to reach
// them is through one of the constructors below — each named after where its value comes from, so choosing
// the wrong one has to be written down rather than typed by accident.
export type ExecutionId = string & { readonly __executionId: unique symbol };

// A standalone run's execution. The run record's `id` is the row; this is what its attempts are opened under.
export function runExecutionId(runId: string): ExecutionId {
  return `evd-run-${runId}` as ExecutionId;
}

// A batch case's execution: `evd-<scorecardId>-<caseId>[-t<trial>]`. Written ONCE — both batch drivers spelled
// this format out for themselves, which is how a format becomes two formats (rule `protocol` L3: a predicate
// written twice has already diverged).
export function caseExecutionId(scorecardId: string, caseId: string, trial?: number): ExecutionId {
  return `evd-${scorecardId}-${caseId}${trial !== undefined ? `-t${trial}` : ""}` as ExecutionId;
}

// A value READ BACK from a record's `executionId` column, which was stamped by one of the constructors above
// (mig 0172). Separate from them because it asserts something different — not "I am building an execution id"
// but "this string already is one" — and because a caller reaching for it while holding a row id has to type
// a name that says so.
export function storedExecutionId(value: string): ExecutionId {
  return value as ExecutionId;
}

// The execution a RUN RECORD's work was placed under, which is where the confusion in this file's header
// actually lives: a standalone run's row id appears inside its execution id, and a scorecard child's does
// not — the child's is `evd-<batch>-<case>` while its row id is random. So a caller spelling `evd-run-<id>`
// inline is correct for one kind of record and silently finds nothing for the other, which is what four
// display lookups and the standalone recovery were doing. One owner, imported.
//
// Prefers the STAMPED column (mig 0172); the derivation below is the fallback for rows written before it,
// and it is lossy exactly where it matters — a multi-trial case's `-t0`/`-t1`/`-t2` rows all derive the
// same id — which is the reason the column exists.
export function recordExecutionId(record: {
  id: string;
  caseId: string;
  executionId?: string;
  parentScorecardId?: string;
}): ExecutionId {
  if (record.executionId) return storedExecutionId(record.executionId);
  return record.parentScorecardId
    ? caseExecutionId(record.parentScorecardId, record.caseId)
    : runExecutionId(record.id);
}
