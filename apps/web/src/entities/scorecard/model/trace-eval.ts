// Reserved sentinel id a scorecard's dataset/harness carries when it scores observability traces DIRECTLY — the
// "evaluate existing traces" path (pick traces from a workspace trace source + run judges, no dataset, no harness run).
// Mirrors @everdict/contracts `TRACE_EVAL_REF` (the web only TYPE-imports contracts, so the value is duplicated here —
// keep in sync). The control plane stamps BOTH dataset.id and harness.id with it; the UI detects it to render a trace
// evaluation instead of a broken dataset/harness deep-link.
export const TRACE_EVAL_REF = '_traces'

// Is this scorecard a direct trace evaluation (no dataset / no harness run)? Keyed on the dataset sentinel, which never
// collides with a real registrable dataset id.
export function isTraceEvaluation(s: { dataset: { id: string } }): boolean {
  return s.dataset.id === TRACE_EVAL_REF
}
