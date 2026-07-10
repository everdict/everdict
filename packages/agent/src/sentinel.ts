// re-architecture P0b: the sentinel codec now lives in @everdict/contracts (job-result-wire) — this is a compat shell.
// It breaks the inverted dependency where backends pulled the whole engine cone (agent) just for parseResult. Removed in the P4 sweep.
export { RESULT_SENTINEL, encodeResult, parseResult, stripSentinel } from "@everdict/contracts";
