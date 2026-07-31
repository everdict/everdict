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

| Wave | Ships | Temporal의 자리 | Unblocks |
|---|---|---|---|
| **W0 착지** | design docs landed in-tree; dossier current; decision lock recorded | — | everything |
| **W1 두 뼈대** | P0 (Run record: kind·origin·class·envelope-stamped·outputs·lineage·placement·lifetime·attach — one migration) + E0 (kind grammar; transitions return `{patch, facts[]}`; same-tx outbox; `agent.run.*`→`run.*` alias) | — (배치 드라이버·시계는 현상 유지) | every later wave |
| **W2 빠른 가치** | P1 (experiment — harness "Try it", ungraded `RunGroup`) + P2 (scoring detached: `POST /groups/:id/score`) + **A6 완전체(승인)** + Driver ops surface **v0** | **T-c `score:<groupId>`** (재채점이 재시작 생존) · **T-a `approval:<id>`** (며칠 durable WAIT — 워크플로는 WAIT만 소유) | headless automation becomes usable; re-score/promote |
| **W3 원장과 게이트** | P3 (agent runs → `Run{kind:agent}` — 활성화 런 **그리고 O1대로 대화 턴까지**(`cause: event\|chat`, 턴=interactive·member-caused, 대화가 그룹); session keeps transcript + `runId`; fleet = console filter; `causedBy` stamping) then P4 (one admission gate; delegated envelopes **meter+headroom**; fan-out guards; **cascade cancel**) + E1 (cursor consumers: notifications/MM/webhooks re-based; LISTEN/NOTIFY nudge; dead-letter + lag) | — (게이트는 워크플로가 아니다 — 안티 카탈로그) | safe agent-scale fan-out; E3 |
| **W4 감각기관** | P5+N0 as one move (TrajectoryStore rung-1 = PG+object; OTLP/HTTP receiver embedded in api; `everdict.*`+`gen_ai.*` semconv published; materialize-on-import; trace out of row embeds **dual-read**; agent transcripts dual-write as TraceEvent) + E2 (coverage W2+W3 facts; "transition ⇒ fact" review rule) | — | N1/N2; judged evidence independence |
| **W5 세션과 내향** | P6 (session runs `kind:sandbox`; exec/terminal/ticket reuse; session cap pool; idle metering) + N1 (Settings › Traces reads our store first; `LiveTraceRef` → internal; chips point home) | **T-b `reaper:<runId>`** (sleep(ttl)+연장/종료 시그널 — reaper=finally를 crash-proof로) | env-image verification by shell; O6 later |
| **W6 지각-행동 루프** | E3 (subscription registry; `schedule.fired` time events; CI events; reactions pass the gate — **= P7**) + N2 (everdict-otel TS/Py + migration recipes; production ingestion GA; **continuous evaluation**) + E4 (trace-derived threshold facts) | **T-d `reaction:<eventId>`** (다단계 반응 실행기 — id가 곧 중복제거) · Temporal Schedules는 시계로 존속 | full autonomy loop |
| **W7 스케일 러그** | N3 (ClickHouse adapter; retention/quota surfaces; **ingestion admission lane in the gate**) + N4 (collector-exporter mirroring subsumes raw sinks; score-attach sinks stay) + Tier-2 workflows as measured need (cascade walker, retention sweeps, re-pin) | Tier-2 기회주의 채택 | ops-scale |

## Temporal 적재적소 — the placement map (final)

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
O4 CP owns the agent-run record · O5 idle sessions bill + short TTL · O6 browser sessions fold later ·
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
