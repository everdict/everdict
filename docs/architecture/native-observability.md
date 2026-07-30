# Native observability — Everdict as the trace platform (OTel-first)

> **Status: DESIGN (maintainer decision, 2026-07-29).** Supersedes-in-direction the *edge-adapter* half of
> [execution-model.md](./execution-model.md) §6: instead of "own the evidentiary copy, treat external
> platforms as import/export edges", Everdict **owns the trace domain itself** — its own OTel-standard
> ingestion, its own tenant-scoped trace store — and external platforms become egress mirrors plus
> import compat-shims. The §6 invariant ("never judge what you don't retain") and the data-plane triad
> stand unchanged; this design makes the invariant trivially true instead of carefully maintained.

## Why (the maintainer's three arguments)

1. **Everdict's agents must see traces.** The agent is a first-class trace *consumer* — "analyze the last
   five runs", "why did this case fail" are trace queries. Pointing that capability at N external
   platforms means N query APIs, N auth flows, N schema drifts under the platform's core feature. A
   tenant-scoped trace view has to be Everdict's own.
2. **Eval → operational runtime requires observability.** If Everdict is to cover the *operating* of
   agentic services, not only their evaluation, then monitoring/observability of those services is table
   stakes. SigNoz proved the shape: embrace OTel as the ingestion standard, own the collector and the
   store, and you can stand up a new-level observability platform without owning any SDK.
3. **Un-owned traces compound complexity.** §6 documented five structural control losses (scores written
   to someone else's ledger, deep links born to dangle, best-effort export, register-time probe decay,
   an asymmetric sync ledger). Every new supported platform multiplies adapters (source + sink + probe +
   browse + inspect). The compromise in §6 was already regrettable — and the regret was signal.

## The reframe that unlocks it

§6 held that "the external half is legitimate — the tenant's observability platform is where their
organization lives, so absorption is impossible." That statement conflated **two legitimacies**:

- **Legitimacy as a view** — their org dashboards, their alerting, their habits. Real, and preserved:
  mirroring outward stays first-class.
- **Legitimacy as the record** — where the truth that *our* platform stands on lives. This was never
  legitimately theirs; we had just not built the alternative.

OTel dissolves the dilemma that made §6 settle for copies: ingestion is **standardized**. Owning the
collector does not mean replacing their platform or shipping a proprietary SDK — instrumentation is a
commodity (OTel SDKs everywhere; Langfuse/LangSmith/Phoenix SDKs and most agent frameworks can already
emit OTLP), and the endpoint is a URL. The 037 lesson ("own the interface, reuse the standard") applies
with a different minimum point of ownership: for images it was the auth plane; for traces it is **the
collector and the store**.

## What already exists (the foothold — this is a turn, not a build-from-zero)

| Piece | Where | Today | Becomes |
|---|---|---|---|
| OTLP span parsing + GenAI-convention normalization | `packages/trace/sources/otel.ts` | pull mode (query their API) | the receiver's core, unchanged |
| `everdict.run_id` correlation tag | stamped at execution (`application-execution/run-case.ts`) | lets pull find our runs | native correlation on arrival |
| `TraceProvenance` extraction | `sources/trace-source.ts` | uniform "Everdict origin" across kinds | ingest-time provenance |
| Span waterfall + browse/inspect | `spans-to-nodes`, Settings › Traces | renders *their* store | renders *our* store first |
| `TraceEvent` vocabulary (+ raw `span` passthrough, artifacts) | contracts | the normalization target | unchanged — the internal contract |
| TrajectoryStore (design) | execution-model §6 | the owned store for run trajectories | the same store, fed by the collector |

## The design

1. **Ingestion front door — an OTel collector per install.** OTLP/HTTP (+gRPC later) in. Tenant isolation
   at the door: **per-tenant ingest tokens** (mint/revoke — the token-server pattern from the managed
   image store, third appearance) route spans to the tenant's partition. v1 signal scope: **traces**;
   logs/metrics ride the same door on a later rung (N-O3).
2. **The store — one port, a storage ladder.** The TrajectoryStore grows into the tenant-scoped trace
   store behind one port: **rung 1** Postgres-index + object-storage bodies (eval-scale; fits the compose
   stack as-is), **rung 2** ClickHouse (ops-scale; the SigNoz-proven engine) as an opt-in adapter. Same
   isolation grammar as the filesystem (partition-per-tenant).
3. **The contract — semantic conventions, not an SDK.** Everdict defines its execution/eval vocabulary as
   OTel semantic conventions: `everdict.run_id` (exists), `everdict.kind`, `everdict.case_id`,
   `everdict.group_id`, plus the standard `gen_ai.*` conventions for LLM calls (model, tokens, cost).
   Scores/verdicts stay **platform-layer records referencing trace ids** — evaluation is our layer *on*
   traces, never span data someone else could overwrite.
4. **Libraries for users, not adapters for us.** `everdict-otel` packages (TS/Python): exporter config +
   semconv helpers + shims for popular agent frameworks; migration recipes for Langfuse/LangSmith SDK
   users (their SDKs speak OTLP — pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at Everdict is config, not
   rewrite). This is the answer to "provide libraries usable from existing trace platforms".
5. **Egress = collector fan-out.** Mirroring raw traces to the tenant's platform becomes collector
   *exporters* (dual-write at the pipe — what collectors are for), replacing bespoke raw-trace sink code
   over time. The score-attach sinks (writing verdicts to their platform's API) remain — scores are ours
   and travel by our hand.
6. **Imports demoted to compat shims.** The pull sources stay for backfill and for platforms that cannot
   push — no longer the primary path. Two-phase `traceRef` collection dies naturally (the trace arrived
   live through the door); `LiveTraceRef` becomes an internal, **stable** link instead of one that
   documents its own decay.
7. **The ops unlock — continuous evaluation.** Production traces in the store + the native scoring path =
   judges over live traffic, platform events derived from trace facts, triggers waking agents on them.
   The observability market is moving observability→eval; Everdict attacks from eval→observability with
   the stronger eval engine.
8. **Capacity plane hookup.** Ingestion is a new admission lane in the §5 gate: per-tenant span/byte
   quotas, sampling policy, retention as a budget dimension. A trace firehose is the data-plane twin of
   runaway fan-out — same governance grammar (quota 429s at the door, never silent drops).

## What it dissolves (§6's five losses, revisited)

| Loss (§6) | After |
|---|---|
| attach-mode writes to their ledger | their trace is the *mirror*; ours is the record |
| deep links born to dangle | primary links are internal and stable; external links best-effort UX |
| export is best-effort | still is — and now that is *fine*, because a mirror may be lossy; the record may not |
| probe = register-time truth | no inbound dependency left to probe; egress mirrors keep their probe |
| asymmetric sync ledger | import provenance is native ingest metadata; export outcomes unchanged |

## Costs (honest)

- **Storage engine + volume.** Ops traces ≫ eval traces. The ClickHouse rung is real infrastructure
  (+1 compose container, operational learning). Hence the ladder: rung 1 default keeps self-hosted light.
- **Retention becomes our bill.** Per-tenant quotas, TTLs, sampling are product surface now, not config
  trivia. The usage meter grows an ingestion dimension.
- **Collector operations.** Backpressure, drop policy, availability. Self-hosted-first distribution
  softens this — each install runs its own door.
- **Scope discipline.** v1 = AI-execution observability (agents, LLM apps, services under test), not
  general APM. OTel carries metrics/logs too — later rungs by decision, not drift.
- **No rip-out.** Pull-mode features (MLflow live-verified, etc.) remain as shims; existing sink users
  keep working through the transition.

## Phasing

> **Sequenced by [execution-master-plan.md](./execution-master-plan.md)** (plan of record — waves W0–W7; decisions locked at recommended values).


- **N0 — Conventions + the door.** Publish the `everdict.*` semconv; OTLP/HTTP receiver (api-embedded for
  v0) + tenant ingest tokens; normalize → TrajectoryStore. Dogfood: our own harness/agent traces land
  through the door (replacing two-phase pull where the harness can emit OTLP).
- **N1 — Look inward.** Settings › Traces primary tab reads our store (browse/inspect/waterfall reuse);
  `LiveTraceRef` → internal link; trace chips point home. **First rung SHIPPED (master-plan W5)**:
  `TrajectoryStore.list` (metas only, keyset cursor) → `GET /trajectories` + `list_trajectories` (the
  browse surface over the owned ledger), Settings › Traces gains the PRIMARY "everdict traces" section
  (each row opens its run — the run is the home), and the run detail page dual-reads: row embed first,
  else the sealed trajectory (labeled with its provenance source) — this is how agent/sandbox/OTLP runs
  render a trace at all. Remaining: chat trace chips for own-store trajectories ride the existing `run`
  reference (zero new contract); a dedicated internal waterfall + `LiveTraceRef` internal rewrite arrive
  with the N2 ingestion surfaces.
- **N2 — Libraries + production ingestion.** `everdict-otel` (TS/Py) + migration recipes; continuous
  evaluation (judges over live traces; platform events from trace facts).
- **N3 — Scale rung.** ClickHouse adapter; retention/quota surfaces; ingestion admission in the §5 gate.
- **N4 — Mirror consolidation.** Collector-level exporters subsume raw-trace mirroring; score-attach
  sinks remain API-side.

## Open decisions

- **N-O1 — Storage default:** rung 1 (PG+object) default with ClickHouse opt-in, or ClickHouse from N0?
  *Rec: rung 1* — the compose stack stays light; the port makes the swap invisible.
- **N-O2 — Receiver placement:** embedded OTLP/HTTP endpoint in the api (N0) vs sidecar stock collector.
  *Rec: embedded first, sidecar at N2* for gRPC/perf/fan-out.
- **N-O3 — Signals:** traces-only v1; logs/metrics later? *Rec: traces-only* — scope discipline.
- **N-O4 — Do bespoke raw-trace sinks retire at N4?** *Rec: yes*, after collector exporters prove parity;
  score-attach sinks stay.
- **N-O5 — Sampling defaults:** head vs tail sampling and who owns the knob (platform default + tenant
  override). *Rec: no sampling at eval-scale; tail-sampling introduced with the ClickHouse rung.*

## Non-goals

- **Not general-purpose APM** in v1 — no infra-metrics dashboards; AI-execution observability first.
- **Not replacing the tenant's org-wide observability** — mirrors are first-class and the collector
  fan-out exists precisely to keep their dashboards fed.
- **Not a proprietary SDK** — conventions over standard OTel only; leaving Everdict is removing an
  endpoint, which is exactly why choosing it is safe.

Cross-links: [execution-model.md](./execution-model.md) §5–§6 ·
[trace-sink.md](./trace-sink.md) (raw-mirror half superseded at N4; score-attach half stands) ·
[workspace-scoped-integrations.md](./workspace-scoped-integrations.md) (trace-source pool → shim registry).
