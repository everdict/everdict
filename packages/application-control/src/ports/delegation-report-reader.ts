import type { DelegateReport, DelegateStatus, DelegationBrief, ReadResult } from "@everdict/contracts";

// ── WHAT A DELEGATION PRODUCED, READ FROM THE DELEGATION (DEFAUL-38) ─────────────────────────────────
//
// The `change` grade needs the delegate's report to land a round, and it must NOT get it from the caller. A
// supervisor who retypes the report into the round is the re-derivation protocol L3 bans: the answers, the
// commits and the gate numbers would then be whatever the typist believed, and the round would be a
// description of the work rather than a record of it. So the report is read from the session that produced it,
// through this port, and the brief is read the same way — as the STRUCTURED document the handoff authored,
// never re-parsed out of the rendered `BRIEF.md` (the ids in a rendered brief are text, and a text id that
// nearly matches is worse than one that does not).
export interface DelegationWork {
  runId: string;
  // The brief as it was AUTHORED. `doneWhen` is what the delegate was actually asked about, which is the only
  // way to tell "it skipped a criterion" from "it was never given that criterion".
  brief: DelegationBrief;
  // ⚠️ OPTIONAL, AND ITS ABSENCE IS A REAL ANSWER. A delegate can end a turn without filing a report — the
  // delegate-state union says so, and "finished without telling me what it did" is a fact a supervisor needs.
  // Synthesizing an empty report here would turn that into a delegate that answered nothing, which reads
  // exactly like one that skipped every criterion. The caller refuses; it does not invent.
  report?: DelegateReport;
  // Where the delegate ended. A round may be logged from a `completed` or an `awaiting` delegate — the second
  // stopped on a question, and the round records that it did — but never from one still running.
  status: DelegateStatus;
}

export interface DelegationReportReader {
  // ⚠️ THREE ANSWERS. `absent` = this control plane has no such delegation (a wrong id, or one whose session
  // is long closed); `unknown` = the read did not happen. They are NOT the same, because the first is a
  // refusal the caller deserves and the second is a round that must not be logged at all — a delegation
  // nobody could read is not a delegation that produced nothing (protocol L2).
  read(tenant: string, runId: string): Promise<ReadResult<DelegationWork>>;
}
