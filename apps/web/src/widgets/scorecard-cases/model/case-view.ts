import type { ScorecardCaseFacts } from '@/entities/scorecard'

// The serialized case view the scorecard detail (server) hands to the case explorer (row list + detail
// dialog). The server component finishes every computation — verdict, localized runner hint, summary lines —
// and passes flat values; the client never recomputes one (the verdict is whatever the server served).
//
// **This type carries only what a ROW draws.** On a batch of hundreds, shipping one case's whole evidence is
// exactly what freezes the screen: the task body (kilobytes per case), every score's rationale, the full
// error text and a base64 screenshot were all multiplied by the case count while none of them was drawn by a
// row. Those four moved to `ScorecardCaseDetail`, fetched for the one case a dialog opens — the same door the
// trace already went through.

export type CaseScoreView = {
  graderId: string
  metric: string
  // Absent on a row that is not a measurement (grader died / judge skipped): the contract's Score is a
  // status-discriminated union and its unmeasured/invalid variants carry no `value` at all — there is no
  // placeholder zero to render.
  value?: number
  pass?: boolean
  label?: string
  status?: string
}

// The verdict's audit trail — which authority layer decided, under which aggregation, from which
// measurements (the server-computed verdictBasis, verbatim).
export type CaseVerdictBasisView = {
  authority: string
  aggregation: string
  deciders: { metric: string; graderId: string; pass: boolean }[]
}

export type CaseSnapshotView = {
  kind: string
  url?: string
  domRef?: string
}

// Which world this case actually ran in — the execution manifest as recorded. `osResolved: 'defaulted'` means
// the case never named an os and a default decided it (a different fact from a declared linux). Absent means
// there is no record at all, so the strip hides rather than inventing "linux".
export type CaseExecutionView = {
  os: string
  osResolved: string
  driver?: string
  image?: string
  runtime?: string
}

export type ScorecardCaseView = {
  // The row's unique key. A trialled batch repeats one caseId across several rows, so the id alone cannot
  // identify a selection: unique cases keep their caseId, repeated ones become `caseId#n` (n = the occurrence
  // in the list).
  key: string
  caseId: string
  // The 1-based trial number, present only when the same caseId appears more than once — the dialog header
  // says which trial you are looking at.
  trial?: number
  // The 0-based occurrence in the record's ORIGINAL results order. It is the coordinate that asks for this
  // row's evidence and embedded trace; a caseId alone collapses every trial onto the first row.
  occurrence: number
  verdict?: boolean
  verdictBasis?: CaseVerdictBasisView
  scores: CaseScoreView[]
  // The child run that executed this case. When present, the dialog reads the trajectory from the ledger.
  runId?: string
  // Deep link to the original/exported trace on the observability platform (trace sink).
  exportUrl?: string
  sinkKind?: string
  snapshot?: CaseSnapshotView
  // Did this case leave a screenshot? The image itself (hundreds of KB per case when it is an embedded
  // base64) is fetched after the dialog opens — the list only needs to know it exists, and in fact does not
  // draw even that.
  hasScreenshot: boolean
  // How the case died — the count of trace error events and the first one's opening line. The full text
  // belongs to the dialog.
  errorCount: number
  errorSummary?: string
  // Self-hosted runner failure hint — a sentence the server already localized (reading the roster is the
  // server's job).
  runnerHint?: string
  // Can execution evidence be opened from the embedded trace even without a child run (legacy · ingest)?
  hasTrace: boolean
  // The execution manifest — only a producer that actually took compute records one.
  execution?: CaseExecutionView
  // The dataset case definition: "what was this case". Absent on a trace evaluation or a failed dataset read.
  // This is the list's one line, not the body — the dialog fetches the body separately.
  taskSummary?: string
  envKind?: string
  graderIds?: string[]
  tags?: string[]
  timeoutSec?: number
}

// One score's evidence — a judge's rationale (detail) and, when the score is not a measurement, the reason it
// is not (reason). Both are read only once a case is open, so neither rides the list payload.
//
// **It carries WHICH score it belongs to as two fields.** Joining them into one `${graderId}:${metric}` key
// is what must not happen: a graderId is a name the workspace chose and judge metrics are already spelled
// `judge:<id>`, so grader `judge` + metric `style:tone` and grader `judge:style` + metric `tone` produce the
// same key. Judge A's reasoning would then sit silently under judge B's row — the worst kind of quiet wrong
// answer on a screen that sells a defensible verdict, and precisely the "never re-derive identity from
// rendered output" of protocol law 3.
export type CaseScoreEvidence = {
  graderId: string
  metric: string
  detail?: unknown
  reason?: string
}

// The heavy half, fetched one case at a time when the dialog opens.
export type ScorecardCaseDetail = {
  // The dataset case's full task body (markdown).
  task?: string
  // The full text of the trace's error events.
  errors: string[]
  // os-use screenshot — a base64 data URL (dev) or the offloaded object-storage URL.
  screenshotSrc?: string
  // One entry per score that has evidence. It is a list rather than a map to avoid minting a joined key at
  // all, not because anything depends on its order.
  evidence: CaseScoreEvidence[]
}

// This score's evidence — the entry whose BOTH fields match. The row and the dialog look it up the same way.
export function findCaseEvidence(
  evidence: CaseScoreEvidence[] | undefined,
  score: { graderId: string; metric: string }
): CaseScoreEvidence | undefined {
  return evidence?.find((e) => e.graderId === score.graderId && e.metric === score.metric)
}

// Does the row view actually carry the facts the list's axes (entities/scorecard's case-list-view) read?
// Bound at compile time, because the two drifting apart makes a filter quietly answer wrong rather than
// break: a missing field yields an empty array, and an empty array reads as "this case has no such value".
type AssertAssignable<A extends B, B> = A
type _caseFacts = AssertAssignable<ScorecardCaseView, ScorecardCaseFacts>
