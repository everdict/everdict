---
paths: "packages/harnesses/**"
---
# Harness rules (push)

A harness = the agent under test, driven over a process boundary. See skill `harnesses`.

- Implement `EvaluableHarness` from `@everdict/contracts`; carry a pinned `version` (the unit of versioning).
- Emit cost/tokens in the trace (`llm_call.cost`). Claude reports `total_cost_usd`; for harnesses that don't, capture usage yourself. LocalDriver uses the machine's `claude` login (no API key needed).
- `run()` MUST yield normalized `TraceEvent`s — convert the harness's native output (e.g. Claude Code `--output-format stream-json`) in an adapter; never leak raw output upstream.
- A harness keeps yielding `TraceEvent` from `run()` — deliberately: it is a black box over a process boundary, a CLI reports points as they happen, and the live playground needs them before any span could close. The span RECORD is assembled from that stream at the seal choke point (`eventsToSpans`), which refuses rather than guessing when the stream cannot be dated. See `docs/architecture/otel-trace-model.md`.
- Every minted event carries `at` — build it with `stamp(now)` (`@everdict/contracts`), never `t: Date.now()` by hand. `t` is the emitter's own scalar in an unstated unit; `at` is the only thing that puts the event on the trajectory reader's wall clock. Stamp the span edges too (`spanId` on a `tool_call`, `parentId` on its `tool_result`) or the waterfall degrades to a flat list.
- Platform-exported traces (OTel/MLflow) are NOT pulled inside `run()` — implement the optional
  `traceSource()`/`collectTrace(runId)` hooks (correlate with `ctx.runId`); `runCase` pulls after compute
  release. See `docs/architecture/streaming-case-pipeline.md` D4.
- **A registered trace source/sink is ADDITIVE — everdict's own ledger is never the thing it replaces.** Keep
  emitting your own account of the run (invocation, exit, the output you saw) even when a platform holds the
  agent's; only the ANSWER stays single-sourced (raw output becomes a `log`, not an assistant `message`, when
  the platform's trace already carries it).
- Install into the provided `ComputeHandle`; do not assume host state.
- Map harness failures to `AppError` (`HARNESS_INSTALL_FAILED` / `HARNESS_RUN_FAILED`).
