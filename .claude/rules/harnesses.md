---
paths: "packages/harnesses/**"
---
# Harness rules (push)

A harness = the agent under test, driven over a process boundary. See skill `harnesses`.

- Implement `EvaluableHarness` from `@everdict/contracts`; carry a pinned `version` (the unit of versioning).
- Emit cost/tokens in the trace (`llm_call.cost`). Claude reports `total_cost_usd`; for harnesses that don't, capture usage yourself. LocalDriver uses the machine's `claude` login (no API key needed).
- `run()` MUST yield normalized `TraceEvent`s — convert the harness's native output (e.g. Claude Code `--output-format stream-json`) in an adapter; never leak raw output upstream.
- Platform-exported traces (OTel/MLflow) are NOT pulled inside `run()` — implement the optional
  `traceSource()`/`collectTrace(runId)` hooks (correlate with `ctx.runId`); `runCase` pulls after compute
  release. See `docs/architecture/streaming-case-pipeline.md` D4.
- Install into the provided `ComputeHandle`; do not assume host state.
- Map harness failures to `AppError` (`HARNESS_INSTALL_FAILED` / `HARNESS_RUN_FAILED`).
