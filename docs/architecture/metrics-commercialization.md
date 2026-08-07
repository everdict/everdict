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
| `POST /scorecards/gate` (+ `gate_scorecards`) | paid core | the CI decision artifact: `pass \| block \| blocked_missing \| not_comparable` — TWO non-pass, non-regression decisions are first-class and neither reads as a green light: `not_comparable` (the comparison does not hold — policy mismatch / zero shared cases) and `blocked_missing` (it held, but not over enough). Trials → Fisher-gated regressions are authoritative, under the policy's own `zThreshold`/`minDelta`, with optional Benjamini-Hochberg correction across the per-case tests (`fdrAlpha`). A case the CANDIDATE's verdict policy declared critical blocks on collapse or absence regardless of any of that (reason `critical_case_failed`). Decision (with embedded policy + digest) is recorded on the candidate (`gates` jsonb, mig 0128) with a `scorecard.gate.decided` fact. |
| `POST /scorecards/:id/gate/override` (+ `override_scorecard_gate`) | governance | the recorded force: only a blocking decision (`block` **or** `blocked_missing`), exactly once, with who+why (`scorecard.gate.overridden`). |
| `GET /workspace/audit/gates` (+ `get_workspace_gate_audit`) | enterprise | decisions counted by outcome (`blockedMissing` counted apart from `block`), overrides enumerated with reasons, `overrideRate` over the overridable blocks (absent when none). |
| `POST /scorecards/:id/verify-manifest` (+ `verify_scorecard_manifest`) | enterprise | stamped digests vs the CURRENT registry: match/drifted/missing/unverifiable + the FNV identity caveat. |
| `GET /scorecards/flake` (+ `flake_scorecards`) | paid core | cross-batch (case, harness@version, runtime) verdict variance under each batch's OWN stamped policy — advisory, nothing auto-quarantined. |
| `deploy/grafana/` | on-prem | operator dashboard + alert rules over the operator scrape. |

## Rules that keep it honest

- **One derivation home.** Numbers live in `@everdict/domain` (`workspaceOpsReport` / `evaluateGate` /
  `gateAudit` / `flakeIndex`), schemas in `@everdict/contracts`; routes/tools serve them verbatim.
- **A rate with a zero denominator is ABSENT, never 0%** — the trust-kernel rule, carried through every
  surface here.
- **The gate is FAIL-CLOSED on missingness.** `GatePolicy.comparability` defaults (semantically, in
  `evaluateGate` — never as a Zod default, so a recorded policy keeps its digest) to `require_full`: a
  `partial` comparison is `blocked_missing`, because "0 regressions" over the 60 cases that survived a
  100-case baseline is evidence about 60 cases, not evidence that nothing regressed. A caller that wants to
  decide on a subset says `allow_partial` and states its tolerance (`maxMissingCases` / `maxMissingFraction`,
  the fraction measured against the BASELINE's case count — a candidate that ADDED cases lost no coverage).
  `maxUnmeasuredFraction` is enforced under EITHER mode against the worse side's coverage: unmeasured scores
  never make a comparison `partial`, they hollow it out from the inside, so gating that limit on the
  comparability mode would make it unreachable.
- **Product judgment precedes statistics in exactly ONE place, and only by declaration.** A login case going
  baseline 3/3 → candidate 0/3 is Fisher p=0.1 — an honest "not significant" — and shipping a fully broken
  login on that arithmetic is still wrong. So `VerdictPolicy.criticalCases` (case-id matchers: `{caseId}` or
  `{prefix}`) names the cases whose collapse blocks REGARDLESS of significance, of `maxRegressions`, and of
  any missingness tolerance — a critical case that is simply absent from the candidate blocks too, because
  "we accept losing some coverage" was never an acceptance of losing that one. Criticality lives in the
  VERDICT POLICY document, not in the gate call: it is digest-covered, manifest-carried and three-state
  resolved with the rest of the stamp, so a recorded decision stays re-derivable from the record instead of
  from whatever flags CI happened to pass. It is declared per batch at submit
  (`POST /scorecards` `criticalCases` → `composeVerdictPolicy`). Nothing fires unless someone declared it:
  statistics stay in charge everywhere else, by default.
- **Every case is its own hypothesis test.** 200 cases each gated at α≈0.05 produce ~10 false regressions by
  construction, and under `maxRegressions: 0` any one of them blocks every release. `GatePolicy.fdrAlpha`
  applies Benjamini–Hochberg across the per-case trial tests of ONE evaluation (sort the m p-values, reject
  up to the largest rank k with p₍ₖ₎ ≤ (k/m)·alpha), holding the expected share of false blocks at that
  level; the practical `minDelta` floor still applies on top. It is OPT-IN — the correction trades a higher
  per-case miss rate for controlled false blocks, and that is the caller's call — and an unset `fdrAlpha` is
  bit-for-bit today's behavior. A regression the correction withdrew is not listed as a regression but is
  marked `fdrSuppressed` on its trial delta and counted in `evidence.suppressedByFdr`, so a pass can explain
  itself ("significant before correction, not after").
- **Labels are closed vocabularies only** (CaseOutcome states, `unmeasured.reason`). graderId/caseId never
  label a series — unbounded cardinality kills a scrape.
- **Ledger-derivation, no new stores.** Gate decisions ride the candidate's row; the audit scans the ledger.
- **Settle events fire through one helper** (`batchSettledEvent`) from BOTH batch drivers (in-process +
  Temporal) — two paths, one derivation (the rescore-predicate lesson).

Plan of record: digo-edu reference `everdict-metrics-commercialization-plan.html`.
