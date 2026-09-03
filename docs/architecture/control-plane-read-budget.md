---
kind: wiki
title: "Control-plane read budget — no read grows with the workspace"
status: current
updated: 2026-09-03
anchors: [packages/db/src/client.ts, packages/contracts/src/infra/outbound-deadline.ts]
---
# Control-plane read budget — no read grows with the workspace

> **Status: landed.** [long-horizon-trace-reads.md](./long-horizon-trace-reads.md) removed the reads whose
> cost grew with ONE run's trace. This document is the other axis: the reads whose cost grew with the
> workspace's whole history, and the missing ceilings that turned any one of them into a total outage.
> Same failure, different denominator.

## The defect, stated once

**A slow read had no deadline, and an unbounded read had no bound — so a local slowdown became a global one.**

The control plane is one process over one connection pool. Three ceilings were left at their driver defaults:

    max: 10                        the whole control plane shares TEN connections
    connectionTimeoutMillis: 0     a caller finding the pool empty waits FOREVER
    statement_timeout: unset       a slow statement holds its connection FOREVER

Individually each is defensible. Composed, they say: any handful of expensive reads takes every slot, holds
it with no server-side deadline, and every other route in the process — including ones that touch none of
that data — queues behind them without a deadline either. The symptom is "the API times out", which is the
hardest possible starting point, because the endpoints that time out are mostly not the ones at fault.

## What must hold

1. **Every ceiling has a value.** "No limit" and "the limit nobody chose" must not be the same configuration.
   `poolConfig` (`@everdict/db`) owns them, and `client.test.ts` asserts them, because a ceiling nobody can
   assert on regresses the next time that constructor is edited.
2. **A screen's filter belongs in the query.** If a read is followed by `.filter(...)` that throws most of the
   rows away, the filter is in the wrong place — and the cost of the screen then grows with everything the
   workspace has ever done rather than with what it is showing.
3. **A bounded page followed by an unbounded step is unbounded.** Read what happens AFTER every limit with
   that limit in force (skill `code-review`, pass 4).
4. **A background lane gets its own POOL, never a longer deadline on the shared one.** Raising
   `statement_timeout` to accommodate a sweep hands that allowance to every request handler.
   Where a sweep's statements can be scoped to fit the ordinary deadline instead, that is better still: it
   removes the second lane, and a second lane is one more thing to keep in step.
5. **A `HAVING` is not a `WHERE`.** On a key-ordered engine, a predicate the planner can only apply after
   aggregation prunes nothing. Cursor, window and tenant are ROW predicates or they are decoration.

---

## The ceilings *(landed)*

`makePool(connectionString, tuning?)` builds from `poolConfig`, which sets all five:
`max`, `connectionTimeoutMillis`, `idleTimeoutMillis`, `statement_timeout` and
`idle_in_transaction_session_timeout`, plus an `application_name` so `pg_stat_activity` tells the request path
from a background sweep. An operator overrides them with `EVERDICT_PG_POOL_MAX`,
`EVERDICT_PG_STATEMENT_TIMEOUT_MS` and `EVERDICT_PG_CONNECTION_TIMEOUT_MS`; unset means the package default,
never "unbounded".

`statement_timeout` is server-side deliberately. node-pg's client-side `query_timeout` abandons the JS promise
while Postgres keeps executing and keeps holding the connection — it bounds the CALLER and not the RESOURCE,
which is the opposite of what pool starvation needs.

The ClickHouse adapter gets the same treatment through its own transport: every statement carries
`max_execution_time`, `max_result_bytes` and `max_memory_usage`, and the client `AbortSignal` fires a couple
of seconds LATER than the server's budget so the engine cancels its own work and answers, rather than us
dropping a socket while the query runs on. Never `result_overflow_mode=break`: a truncated answer served as a
complete one is invented evidence, in a store that holds what verdicts rest on.

## The narrowing rule *(landed)*

Four reads asked for a collection and kept a handful:

| read | asked for | wanted | now |
|---|---|---|---|
| `GET /workspace/pulse` | every scorecard the workspace ever produced | two windows' worth | `createdSince` |
| `GET /workspace/pulse` | every project / initiative | the LIVE ones | `statuses` |
| queue snapshot | the whole run ledger (`SELECT *`, heavy `result` jsonb) | queued + running | `statuses` |
| boot recovery | the whole run ledger, **every workspace** | queued + running | `statuses` |

The pulse is the sharpest case because it is the home screen: one request issuing ~10 reads in parallel, so a
single page view took most of a ten-connection pool, and its scorecard read carried jsonb summary columns for
the workspace's entire history. Two users opening the dashboard was enough to starve every other route.

Boot recovery is the most dangerous one, because it is what a crashed replica has to finish before it can
serve anything: it was `SELECT *` over the run ledger of every tenant, to find the rows still in flight.

**And a per-item read inside a loop is the same defect wearing a different hat.** The queue screen computed
each running batch's progress by listing every child of that batch — N+1 in running batches, each of the N
unbounded in dataset size, all to produce three integers. `RunStore.countChildrenByStatus(tenant, ids)`
answers every batch at once and reads only the column the answer depends on.

## The screens ask narrower questions *(landed)*

The API-side ceilings above stop a screen from taking the process down; they do not make the screen's
question smaller. Four `apps/web` reads asked for the workspace's whole scorecard history and then narrowed
in JavaScript, and one of them was the reason a blind page size could not simply be imposed on
`GET /scorecards`:

| screen | asked for | now |
|---|---|---|
| Scorecards › by harness | every scorecard, to COUNT per harness | `GET /scorecards/counts?groupBy=harness` + one harness's page |
| Dataset detail | every scorecard, to find this dataset's harnesses | `{ dataset: id }` — exact, same chips |
| Scorecards › compare | every scorecard, for a picker AND to look up the two selected | a succeeded page for the picker + `getScorecard(id)` for each side |
| Activity feed | every standalone run AND every scorecard, paginated in the browser | a depth on both |

**The by-harness case is why a cap on `GET /scorecards` would have been the wrong repair.** That page's
picker labels are counts, computed from the rows it received — so giving that read a page size would not have
made the screen slower or emptier, it would have made the NUMBERS WRONG, quietly. The count is a question the
server already answers exactly, and moving it there is what lets the list become a page.

`limit` also had to start travelling: `controlPlane.listRuns` spelled it into the URL on the `runner` branch
only, while offering it on every call's option type — a value that compiles, arrives, and is never read
(rule `typescript`'s excess-property shape). One builder now renders the path for every branch.

Two reads are deliberately left unbounded, and both for reasons a page size cannot fix. The dataset and
harness LIST widgets derive relations — which harnesses have evaluated this dataset — which is a distinct-pair
aggregate no endpoint answers yet; a page would silently drop relations rather than shorten a list. And
`loadAnalysisData` is the analysis engine: breadth under a filter is what it is for, and narrowing it changes
its results rather than its cost.

## The engine's key order is part of the query *(landed)*

`everdict_trajectories` is `ORDER BY (tenant, sealed_at, run_id)` on ClickHouse. Three reads ignored it:

- **The ingestion meter.** `ingestedSince` put the time filter outside two `GROUP BY`s, so admitting one OTLP
  push read every row the workspace had ever sealed. The window is a row predicate now — which also FIXED the
  answer: a plane is metered by its own seal stamp, so a service pushing spans into an older run is this
  hour's ingestion rather than none. Both rungs changed together (`ingestion-window.counterexample.test.ts`).
- **The browse list.** The keyset cursor lived in a `HAVING` over a fifteen-column `argMin` aggregate, so page
  40 cost exactly what page 1 did and both cost the whole history. It is two statements now: which runs are on
  this page (narrow columns, cursor as a `WHERE`, a key-range read), then the wide aggregate for those ids.
  Exact, not approximate — a run survives the `HAVING` only if its earliest seal is at or before the cursor,
  and every row at or before the cursor is inside the prefilter.
- **Run lookups.** `planeRows` named only `run_id`, the THIRD key column, so it fell back to the `idx_run`
  bloom filter — or, on an install created before that index existed, to a full scan. The read paths pass the
  tenant now. `seal` deliberately does not: its probe asks "do rows exist here belonging to another
  workspace?", and a tenant-filtered read answers "no rows" to exactly the case it must refuse.

Two more ClickHouse repairs ride along. `deleteRuns` used `ALTER TABLE … DELETE`, a MUTATION that rewrites
every part it touches — and with no `PARTITION BY` on these tables, that is the whole table, hourly; it uses
the lightweight `DELETE FROM` its sibling path already used. And the skipping index is declared from one
descriptor now, like the columns, so an upgraded install stops silently running a different schema from a
fresh one (existing parts still need an operator's `MATERIALIZE INDEX`, which `ensureSchema` names rather
than performing — that is a whole-table mutation and not something a boot should do to a live database).

## The other direction: outbound calls *(landed)*

Everything above is about what the control plane READS. The same defect exists on what it DIALS, and the
resource it holds is the same one:

    a statement with no `statement_timeout`   ≡   an outbound call with no `AbortSignal`

The control plane calls other people's software from a request handler — an identity provider during login,
a tenant's MLflow/Langfuse during pull-ingest and connect-probes, GitHub while a CI link is set up, an
orchestrator while a job is placed, our own agent service during an approval. Every one of those was
`fetch(url, init)` with no signal, so the remote decided how long OUR request lasted while holding a
connection every other route shares. The idiom already existed and had been applied exactly twice
(`PROBE_TIMEOUT_MS` in the registry reader and the Mattermost client), which is the tell rule `protocol`
names: a safety decision every new lane must remember to import is a convention, not a protocol.

`deadlineFetch` (`@everdict/contracts`, beside `refuseUnsafeOutboundUrl` and admitted for the same reasons)
wraps a transport so every call carries a deadline, composing with the caller's own signal rather than
replacing it — replacing it would silently drop "the client went away", which is the abort that matters most.
It is applied at the `fetchImpl ?? fetch` seam every adapter already has, so a test's fake is wrapped too and
the wrapper is the choke point rather than one more thing to remember.

Two lanes are deliberately NOT wrapped, and both for the same reason: **an `AbortSignal` aborts the body, not
just the handshake.** `@everdict/llm` streams a completion, and a deadline there would cut the stream. Agent
calls (`agentFetch`, `apps/api/src/common/agent-fetch.ts`) get their own, much longer budget because what is
on the other end is an agent TURN — a deadline shorter than the legitimate work turns a working feature into
an intermittent failure. The point is never that 30 seconds is right; it is that a value exists.

## ClickHouse partitioning *(landed, with a rebuild path)*

`PARTITION BY substring(sealed_at, 1, 7)` — monthly, on both trajectory tables, so a run's planes and its
event rows expire together. Without it every delete touched the whole table, which is the hourly cost of the
sweep on the fastest-growing table in the product.

A partition key has **no `ALTER`**, and `CREATE TABLE IF NOT EXISTS` is a no-op on a table that exists — so
shipping it in the CREATE alone would reintroduce the fresh-vs-upgraded divergence that adapter's
one-descriptor rule exists to remove, in the one dimension that rule cannot cover. So it ships as three
pieces, not one: the CREATE, a boot-time **read-back** of the live key from `system.tables` that names the
difference out loud, and `scripts/live/repartition-clickhouse-trajectories.mjs`, which rebuilds through
`EXCHANGE TABLES` after comparing row counts and keeps the old table behind. The rebuild is not done at boot:
copying a ledger is not something a process should do to a production database while starting up.

## Postgres indexes *(mig 0210)*

Every index on `everdict_trajectories` led with `tenant`, which is right for the browse page and useless for
retention: that asks "everything older than this cutoff, across every workspace", and with `tenant` in front
the planner can use none of them. So the hourly sweep seq-scanned the fastest-growing table in the product,
three times per pass. `(sealed_at)` serves it; `everdict_trajectory_segments (tenant, sealed_at)` serves the
ingestion meter's new read of that table.

## Measured, not argued

Everything above was designed from key order and from reading the queries. It is also measured, on throwaway
engines seeded to a realistic shape — Postgres 16 with 200k runs (111 MB), 20k scorecards, 60k trajectories,
300k segments and 800k event rows (523 MB); ClickHouse 24.10 with 300k plane rows over 60k runs and twelve
months. `EXPLAIN (ANALYZE, BUFFERS)` and `system.query_log`:

| read | before | after |
|---|---|---|
| retention: `payloadRefsOf`, one page | **11.8 s**, 5.2 M rows expanded, 116 MB disk sort — and called ~40× per sweep | **3.6 s**, 1.4 M rows, 31 MB — called ~2× |
| retention: `expiredRuns`, steady state | Seq Scan, 682 buffers | Index Scan, 16 buffers (mig 0210) |
| boot recovery: active runs | **192 ms**, 180 000 rows, 68 MB disk sort | **0.14 ms**, 90 rows |
| workspace pulse: scorecards | 45 ms, parallel Seq Scan + 14 MB disk sort | 10 ms, Index Scan |
| queue progress, one 600-case batch | 600 rows / **146 kB** of `result` jsonb per poll | 3 rows / ~120 B |
| ClickHouse `ingestedSince` | 168 ms, 287 k rows, **214 MiB** server memory | 4 ms, 0 rows, 4 MiB |
| ClickHouse browse `list` | 236 ms, 287 k rows, **325 MiB** server memory | 30 ms, 10 MiB (step 1) |
| ClickHouse `planeRows` | 14 ms, 2.73 MiB read | 8 ms, 1.25 MiB read |

Two things the numbers said that reading did not:

- **The parameterized `statuses` filter DOES use the partial index.** This was written up as an unverified
  risk — `everdict_runs_active_admission_idx` is `(tenant) WHERE status IN ('queued','running')`, and the
  expectation was that `status = ANY($n::text[])` could not be proven to imply that predicate at plan time.
  It can: Postgres 16 chooses a custom plan with the parameter values in hand, and the measured plan is an
  `Index Scan using everdict_runs_active_admission_idx`, identical to the literal spelling (0.143 ms vs
  0.118 ms). No literal-emitting workaround is needed, and none was written.
- **The sweep's page was still unbounded in WORK.** Scoping the enumeration to the claimed runs fixed the
  corpus-sized drain and left the per-statement cost proportional to `runs × events-per-run × leaves`, of
  which only the first factor was chosen. Measured at 40 events per run: 500 runs → 311 ms, 2000 → 1.3 s,
  5000 → 3.6 s. Linear — so a long-horizon workspace (the very subject of
  [long-horizon-trace-reads.md](./long-horizon-trace-reads.md)) multiplies that by ten or fifty and every
  statement exceeds the `statement_timeout` this document adds, turning a slow sweep into a permanently
  `failed` one. `REF_SCAN_RUNS` chunks the run set so each statement is bounded; the sweep issues more of
  them and deletes the same rows. Found by measuring the fix, not by reading it.

## Deliberately not

- **No caching layer.** Every read here became cheap by asking a smaller question, which is durable; a cache
  over an unbounded read is a second copy of the problem with an invalidation bug attached.
- **No second connection pool for the retention sweep.** Its statements are scoped to one page of expired runs
  now, so they fit the ordinary deadline; one that does not is reported `failed` by `runRetentionSweep` and
  retried on the next interval, which is the behaviour that lane already documents. A second pool would be a
  sibling lane with its own ceilings to keep in step, and the lane that was not taught is this repository's
  most common defect.
- **No ClickHouse `TTL` for retention.** It would delete rows behind the application's back, and an offloaded
  payload is named ONLY by its event row — a TTL sweep would orphan every object those rows pointed at. See
  [long-horizon-trace-reads.md](./long-horizon-trace-reads.md) R1: objects go BEFORE rows, always.
- **No cap on what a harness may emit** — unchanged from R1. Everdict retains what happened.

## Related

- [long-horizon-trace-reads.md](./long-horizon-trace-reads.md) — the other axis: one run's trace.
- [native-observability.md](./native-observability.md) — the owned store, the OTLP door, quota + retention.
- [workspace-pulse.md](./workspace-pulse.md) — what the home screen reads.
- Rule `protocol` L2 — why an unreadable quota is a refusal rather than "no override".
