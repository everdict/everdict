import type { SpanAttrMapping, WorkspaceSettings } from "@everdict/contracts";

// The per-harness span-attribute mapping overlay resolution: the workspace overlay
// (WorkspaceSettings.spanAttrMappingByHarness), authored in the judge wizard against a real picked trace, WINS over
// the harness spec's own traceSource.mapping. It is the mutable conversion layer that sits between a harness version
// and a judge version — independently editable without bumping either immutable spec.
//
// Pure. Applied wherever the control plane builds a trace source for a harness: the dispatch-after judge collect seam
// and the production pull-eval (scorecard ingest) path. Returns undefined when neither overlay nor spec provides one
// (the span→TraceEvent normalizer then uses the OTel GenAI defaults).
export function resolveHarnessTraceMapping(
  settings: WorkspaceSettings | undefined,
  harnessId: string,
  specMapping?: SpanAttrMapping,
): SpanAttrMapping | undefined {
  const overlay = settings?.spanAttrMappingByHarness?.[harnessId];
  return overlay ?? specMapping;
}
