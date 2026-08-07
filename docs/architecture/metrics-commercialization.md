# Metrics commercialization — two products, three bundles, one closed scrape

The operating decision: **operator metrics and customer metrics are different products.** The scheduler/
breaker/dispatch time series belong to whoever operates the control plane (us in SaaS, the customer's infra
team on-prem); the speed/trust/regression numbers belong to the workspace and are served as **product
surfaces**, with Prometheus as one export format among several. Mixing the two on one endpoint is a
cross-tenant leak in SaaS and noise on-prem.

## Surfaces

| Surface | Who | What |
|---|---|---|
| `GET /metrics` | operator (bearer = `EVERDICT_METRICS_TOKEN`, **fail-closed**) | dispatch outcomes+latency, scheduler queue/in-flight, breakers, batch-resilience counters, and the settle-seam series: `everdict_case_outcome_total{outcome}` · `everdict_unmeasured_total{reason}` · `everdict_verdict_latency_seconds` (submit→terminal). Carries per-workspace labels — never tenant-facing. |
| `GET /workspace/metrics` | a workspace (bearer = `ak_` API key) | ONLY the calling workspace's ledger tallies as an OpenMetrics exposition — batch fates, case outcomes, evidence planes, rates (a rate renders only when its denominator exists). |
| `GET /workspace/ops-report` (+ MCP `get_workspace_ops_report`) | every tier | the SLA-evidence read: "our fault vs the harness's fault" — infra-failure/unmeasured/trace-seal rates + evidence tallies, derived by ONE domain fn (`workspaceOpsReport`). |
| `POST /scorecards/gate` (+ `gate_scorecards`) | paid core | the CI decision artifact: `pass \| block \| not_comparable` — `not_comparable` is first-class (policy mismatch / zero shared cases never read as pass); trials → Fisher-gated regressions are authoritative. Decision (with embedded policy + digest) is recorded on the candidate (`gates` jsonb, mig 0128) with a `scorecard.gate.decided` fact. |
| `POST /scorecards/:id/gate/override` (+ `override_scorecard_gate`) | governance | the recorded force: only a BLOCK, exactly once, with who+why (`scorecard.gate.overridden`). |
| `GET /workspace/audit/gates` (+ `get_workspace_gate_audit`) | enterprise | decisions counted by outcome, overrides enumerated with reasons, `overrideRate` (absent when no block). |
| `POST /scorecards/:id/verify-manifest` (+ `verify_scorecard_manifest`) | enterprise | stamped digests vs the CURRENT registry: match/drifted/missing/unverifiable + the FNV identity caveat. |
| `GET /scorecards/flake` (+ `flake_scorecards`) | paid core | cross-batch (case, harness@version, runtime) verdict variance under each batch's OWN stamped policy — advisory, nothing auto-quarantined. |
| `deploy/grafana/` | on-prem | operator dashboard + alert rules over the operator scrape. |

## Rules that keep it honest

- **One derivation home.** Numbers live in `@everdict/domain` (`workspaceOpsReport` / `evaluateGate` /
  `gateAudit` / `flakeIndex`), schemas in `@everdict/contracts`; routes/tools serve them verbatim.
- **A rate with a zero denominator is ABSENT, never 0%** — the trust-kernel rule, carried through every
  surface here.
- **Labels are closed vocabularies only** (CaseOutcome states, `unmeasured.reason`). graderId/caseId never
  label a series — unbounded cardinality kills a scrape.
- **Ledger-derivation, no new stores.** Gate decisions ride the candidate's row; the audit scans the ledger.
- **Settle events fire through one helper** (`batchSettledEvent`) from BOTH batch drivers (in-process +
  Temporal) — two paths, one derivation (the rescore-predicate lesson).

Plan of record: digo-edu reference `everdict-metrics-commercialization-plan.html`.
