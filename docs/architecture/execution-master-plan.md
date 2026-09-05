---
kind: wiki
title: "Execution master plan — sequencing the five designs"
status: current
updated: 2026-08-06
---
# Execution master plan — sequencing the five designs

> **Status: PLAN OF RECORD (maintainer direction, 2026-07-29).** This document *sequences*; it does not
> re-design. The designs it arranges: [execution-model.md](./execution-model.md) (P-phases) ·
> [native-observability.md](./native-observability.md) (N-phases) ·
> [event-plumbing.md](./event-plumbing.md) (E-phases + the Temporal charter) ·
> [orchestration.md](../orchestration.md) (the workflow catalog, T-items). Maintainer intent for this
> plan: **use Temporal exactly where the catalog put it — no more, no less** — and drive the whole arc
> to the closed loop.
>
> **Decisions: locked as working decisions.** All 21 open decisions (O1–O10, N-O1–5, EO1–6) are adopted
> at their recommended values. Each stays cheap to reverse until the wave that lands it ships; overriding
> any of them is a one-line change to this plan, not a redesign.

## The shape: seven waves

Each wave is additive, independently shippable, and ends with an acceptance check that can be run live.
The three tracks (P/N/E) interleave; Temporal items (T-a…T-d) sit **inside** the wave whose phase they
power — never as their own track, because the engine is a tool of a phase, not a goal.

| Wave | Ships | Where Temporal sits | Unblocks |
|---|---|---|---|
| **W0 landing** | design docs landed in-tree; dossier current; decision lock recorded | — | everything |
| **W1 the two skeletons** | P0 (Run record: kind·origin·class·envelope-stamped·outputs·lineage·placement·lifetime·attach — one migration) + E0 (kind grammar; transitions return `{patch, facts[]}`; same-tx outbox; `agent.run.*`→`run.*` alias) | — (the batch driver and the clock stay as they are) | every later wave |
| **W2 quick value** | P1 (experiment — harness "Try it", ungraded `RunGroup`) + P2 (scoring detached: `POST /groups/:id/score`) + **A6 in full (approvals)** + Driver ops surface **v0** | **T-c `score:<groupId>`** (a re-score survives a restart) · **T-a `approval:<id>`** (a durable WAIT of days — the workflow owns only the WAIT) | headless automation becomes usable; re-score/promote |
| **W3 the ledger and the gate** | P3 (agent runs → `Run{kind:agent}` — activation runs **and, per O1, conversation turns too**(`cause: event\|chat`, a turn = interactive and member-caused, the conversation is the group); session keeps transcript + `runId`; fleet = console filter; `causedBy` stamping) then P4 (one admission gate; delegated envelopes **meter+headroom**; fan-out guards; **cascade cancel**) + E1 (cursor consumers: notifications/MM/webhooks re-based; LISTEN/NOTIFY nudge; dead-letter + lag) | — (the gate is not a workflow — the anti-catalog) | safe agent-scale fan-out; E3 |
| **W4 the sense organs** | P5+N0 as one move (TrajectoryStore rung-1 = PG+object; OTLP/HTTP receiver embedded in api; `everdict.*`+`gen_ai.*` semconv published; materialize-on-import; trace out of row embeds **dual-read**; agent transcripts dual-write as TraceEvent) + E2 (coverage W2+W3 facts; "transition ⇒ fact" review rule) | — | N1/N2; judged evidence independence |
| **W5 sessions and inbound** | P6 (session runs `kind:sandbox`; exec/terminal/ticket reuse; session cap pool; idle metering) + N1 (Settings › Traces reads our store first; `LiveTraceRef` → internal; chips point home) | **T-b `reaper:<runId>`** (sleep(ttl) plus extend/stop signals — the reaper makes `finally` crash-proof) | env-image verification by shell; O6 later |
| **W6 the perceive-act loop** | E3 (subscription registry; `schedule.fired` time events; CI events; reactions pass the gate — **= P7**) + N2 (everdict-otel TS/Py + migration recipes; production ingestion GA; **continuous evaluation**) + E4 (trace-derived threshold facts) | **T-d `reaction:<eventId>`** (the multi-stage reaction executor — the id IS the deduplication) · Temporal Schedules live on as the CLOCK | full autonomy loop |
| **W7 the scale rung** | N3 (ClickHouse adapter; retention/quota surfaces; **ingestion admission lane in the gate**) + N4 (collector-exporter mirroring subsumes raw sinks; score-attach sinks stay) + Tier-2 workflows as measured need (cascade walker, retention sweeps, re-pin) | a Tier-2 opportunistic adoption | ops-scale |

## Temporal, in its right places — the placement map (final)

**Sits exactly here:** batch driver + retry batch (today, unchanged) · schedule clock (today; fires
`schedule.fired` into the log from W6) · `score:` (W2) · `approval:` (W2) · `reaper:` (W5) ·
`reaction:` (W6) · Tier-2 items only when W7's measurements ask.

**Never sits here** (anti-catalog, standing): event routing/fan-out · the agent loop · the admission
gate · autoscaler/scheduler control loops · notification fan-out · a session's interactive I/O.

**Expansion disciplines apply to every T-item** (orchestration.md): deterministic workflowId family ·
in the Driver ops surface from day one · facts only via activities' transitions · demand-creating
activities pass the gate.

## Wave acceptance (the live checks that close each wave)

- **W1**: existing suites green; every new run stamped with kind/class/origin; pilot aggregates
  (Run, ScorecardBatch) emit facts from transitions atomically (kill -9 between write and emit is
  unobservable — same tx).
- **W2**: kill the CP mid-re-score of a 100-case group → resumes and completes with zero duplicate
  judging; an approval parked, CP restarted, approved **2 days later** → the run resumes; ops surface
  v0 shows both workflows by ledger ids.
- **W3**: an agent-caused scorecard draws down the agent's envelope and is refused at 402 past its cap
  (never silently); cancelling the agent run cascades to its non-terminal descendants; a consumer
  replays a day of facts by cursor rewind with zero duplicate effects.
- **W4**: our own harness traces arrive through the OTLP door and seal in the TrajectoryStore; a
  pull-ingested trace is judged from **our copy** (delete it on the source platform afterwards — the
  scorecard's evidence still opens); scorecard list for new runs carries refs, not embeds.
- **W5**: environment image → shell in → close → sealed trajectory of the session; kill the CP during
  an open session → the reaper still tears it down on time; Settings › Traces browses our store.
- **W6**: the flagship loop, end to end on one screen: production trace crosses a tenant-configured
  threshold → fact → subscription wakes a triage agent (`class: background`, enveloped) → it re-runs
  the relevant scorecard → regression confirmed → `reaction:` workflow opens the fix-PR → every step
  visible in the activity console with an unbroken `causedBy` chain, and one cancel at the root
  revokes the tree.
- **W7**: a tenant trace firehose hits its quota and receives 429s at the door while other tenants'
  ingest is unaffected; raw-mirror parity proven before bespoke sinks retire.

## Cross-cutting rules (hold in every wave)

1. **Additive always** — no existing surface moves until its replacement is proven (dual-read/dual-write
   patterns are the default bridge; backfills are rejected by default, O10).
2. **The gate is singular** — anything new that creates demand (reactions, ingestion, workflows'
   activities) joins the §5 gate; a bypass is a review-blocking defect.
3. **Boot recovery must shrink** — its size is the standing meter of durability debt; each T-adoption
   should delete recovery code, and a wave that grows it needs a written excuse.
4. **Every workflow visible from day one** — ops surface coverage is part of each T-item's definition
   of done (the 044 adoption gate, applied to ourselves).
5. **Shared-tree discipline** — waves land as normal PRs through `pnpm ci:local`; skills/docs travel
   with the code per CLAUDE.md; concurrent-session isolation per the established commit technique.
6. **Facts, not inference; conventions, not SDKs; pointers for UX, copies for evidence** — the three
   invariant slogans of the designs stay review criteria.

## Decision lock (adopted working values)

O1 chat turns are runs (grouped) · O2 transcripts are traces · O3 generalize ScorecardRecord ·
O4 CP owns the agent-run record · O5 idle sessions bill + short TTL · O6 browser sessions fold later (DONE —
they are `kind: sandbox` session runs; a file run is a `command` run beside them) ·
O7 envelope = meter + headroom + in-flight cap · O8 cascade cancel default (non-terminal descendants) ·
O9 recordings = siblings first · O10 no backfill (dual-read) · N-O1 storage rung-1 default ·
N-O2 receiver embedded first, sidecar at N2 · N-O3 traces-only v1 · N-O4 raw sinks retire at N4 after
parity · N-O5 no sampling until the ClickHouse rung · EO1 facts from transitions · EO2 same-tx outbox
on Pg · EO3 per-subject ordering only · EO4 TTL = max(lag SLO, replay window) · EO5 notification
subscriptions after E1 · EO6 platform-only publishing.

## Risks named (and their parries)

- **Two writers on the run ledger** (agent service + CP) — parried by O4: CP owns the record, the agent
  service reports transitions over the internal route it already uses.
- **Event volume before governance** — E2's coverage expansion waits until W4, *after* the W3 gate
  exists; broad automation (E3) waits until W6. Perception never outruns admission.
- **Storage volume** — rung-1 by design; the ClickHouse rung is entered by measurement (W7), not
  anticipation.
- **Wave-4 double move (P5+N0)** — the riskiest wave technically (a new store + a new door). Parried by
  dogfood-first (our own harness traces), dual-read, and the store port keeping rung-1 swappable.
- **Concurrent-session tree conflicts** — the standing risk of this repo; isolation-commit technique is
  a cross-cutting rule, and waves are sliced to keep each PR narrow.
