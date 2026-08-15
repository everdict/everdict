import type { RunRecord } from "@everdict/contracts";
import type { CaseRunRef, RunListItem } from "@everdict/contracts/wire";
import { childKey } from "@everdict/domain";

// Serve-time annotation of a batch's child runs (arch-review 44). A retried case leaves its abandoned attempt
// parented to the same batch, so `GET /runs?scorecardId=` returns rows the batch does NOT stand on — and it
// returned them looking exactly like the one it does. The batch's commit receipts already decided which row is
// each (case, trial)'s answer; this carries that decision onto the row.
//
// Absence is a third state, and it is deliberate: a case with no receipt (a batch predating the ledger, or one
// straddling its deployment) is UNKNOWN, not superseded. Marking such a row false would invent a supersession
// nobody recorded, so only rows whose own (case, trial) has a receipt are labelled — the same per-case, never
// per-batch, rule the read-model hydration follows.
export function serveBatchChildren(runs: RunRecord[], caseRuns: readonly CaseRunRef[]): RunListItem[] {
  if (caseRuns.length === 0) return runs;
  const canonicalIds = new Set(caseRuns.map((c) => c.runId));
  const receipted = new Set(caseRuns.map((c) => childKey(c.caseId, c.trial)));
  return runs.map((run) => {
    if (canonicalIds.has(run.id)) return { ...run, canonical: true };
    // A superseded attempt often never produced a result, so its trial is unrecorded — trial 0 is the same
    // reading the batch's own hydration takes for a resultless child.
    return receipted.has(childKey(run.caseId, run.result?.trial ?? 0)) ? { ...run, canonical: false } : run;
  });
}
