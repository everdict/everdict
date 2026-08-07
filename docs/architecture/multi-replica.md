# Running more than one control-plane replica

The control plane (`apps/api`) was written against a **single-process assumption**: in-flight work lived in
process memory, singleton loops ran because the process ran, and boot recovery reclaimed everything it found
in flight because nobody else could be holding it. That assumption is written down in several places — the
scheduler's admission maps, `startup-recovery.ts`'s own header, the store-backed runner hub's "pin
self-hosted dispatch to one replica" error text — and every one of them silently degrades when a deployment
scales to N replicas: quotas multiply by N, cron-shaped loops fire N times, and a booting replica reclaims a
living replica's work.

This document is the **deployment contract**: what is replica-global, what is deliberately per-replica, and
what an operator must set to run more than one.

## The rule the fixes follow

A count that bounds a WORKSPACE is a quota and must be fleet-wide; a count that bounds a MACHINE is a fact
about that machine and stays local. The workspace half is always derived from the durable ledger rather than
kept as a counter — a tombstoned row frees its slot by being terminal, so there is nothing to reconcile after
a crash. The session pool learned this the hard way ("a 3-instance deployment gave every workspace three
times the pool", `SandboxSessionService.enforceCapacity`), and the browser session service states both halves
side by side (`browser-session-service.ts` `enforceCapacity`: the global cap "bounds THIS node's browser
processes"; the per-workspace cap is counted from the ledger).

## Replica-global

| Concern | Mechanism |
| --- | --- |
| Tenant concurrency quota | `Scheduler`'s `AdmissionLedger` — `RunStore.inFlightByTenant()` over the run rows |
| Singleton control-plane loops | `LeaderElector` — a Postgres lease; non-leaders keep their timers but no-op |
| Self-hosted runner dispatch | `EVERDICT_SELF_HOSTED_STORE_HUB=1` — the Pg claim queue instead of the in-process hub |
| Front-door callbacks | `StoreCallbackRendezvous` (already store-backed — an inbound POST may land on any replica) |

### Admission (S1)

`Scheduler` keeps five per-process maps (backend slots, memory, cpu, tenant count, per-harness count). Only
the **tenant count** is a workspace quota, and it is the one with no cross-replica truth anywhere else, so it
is the one that moved to the ledger: each drain reads `inFlightByTenant()` once — the same budget as the one
cluster capacity probe a drain already makes — and measures the quota against `ledgerReading + what this
replica has placed since the reading` (never `ledger + local`, which would double-count our own running rows).

What the ledger counts is deliberately narrow, and the predicate is pinned by tests on both store impls:
`status = 'running'` (a `queued` row is still waiting in some replica's queue; counting it against the quota
that decides whether it may start would deadlock a workspace sitting at its cap), of the eval family (a
legacy row with no `kind` is an eval run), and task-shaped (a held-open session is bounded by the session
pool's own cap — counting worlds here would let three open sandboxes block a workspace's evals).

The read is **best-effort**: a ledger that cannot answer falls back to this replica's own counts, because a
scheduler that refuses to place anything while the database blips is a worse outage than a quota that is
momentarily per-replica again. The quota is therefore eventually consistent — it removes the systematic N×
multiplication, not every race between two replicas admitting in the same instant.

### Leadership (S2)

Loops whose step is *read state → act on the world* must run once per cluster, not once per replica. They are
wrapped in `whenLeader(...)`: the timer stays registered on every replica (so failover needs no restart, the
new leader's next tick just starts working) and the callback returns immediately unless this replica holds the
lease. Leadership is one row in `everdict_control_plane_leases` claimed and renewed by a single atomic upsert
whose `WHERE` admits only the current holder or an expired lease, fenced by the DATABASE's `now()` so replica
clock skew can never elect two leaders. A replica stops believing it is leader `ttl − renewInterval` after its
last successful renewal — before the row the others watch can expire — and hands the lease back on shutdown so
a rolling restart fails over immediately instead of waiting out the TTL.

*(Why a lease row and not `pg_advisory_lock`: session advisory locks live on a CONNECTION, and every store here
talks to a `pg.Pool` — a renewal issued on a different pooled connection sees its own lock as somebody else's
and fails forever. A lease row keeps the one injectable `SqlClient` seam the db package is built on, is
testable with the fake client, and behaves identically through a connection pooler.)*

What is gated, and what deliberately is not:

| Loop | Verdict |
| --- | --- |
| `TopologyPoolAutoscaler` (15 s, scales a shared service) | **gated** — read-then-act on shared infrastructure |
| `CommentService.sweepStuckAgentAnswers` | **gated** — it pings the asker; N replicas = N notifications |
| `sweepOrphans` (sandbox · browser) + `settleOrphanSessionRuns` | **gated** — settles rows other replicas wrote, and emits a fact per settle |
| `browserSessionService.sweep()` · `sandboxSessions.sweep()` | not gated — they reap the compute THIS process holds |
| MCP idle-session sweep (`mcp.routes.ts`) | not gated — it evicts this process's own transports |
| Trajectory / event retention | not gated — one atomic `DELETE … WHERE cutoff`; a second replica's pass finds nothing |
| Slot `Autoscaler` (`EVERDICT_AUTOSCALE`) | not gated — `MutableSlots` is this replica's OWN admission envelope; gating it would pin followers at the minimum and stop them placing work |

### Still single-process (tracked separately)

Boot recovery still reclaims in-flight records unconditionally, which across replicas means a booting replica
settles work another replica is actively driving. Until that lands, roll restarts one replica at a time.

## Deliberately per-replica

- **Backend slots, memory budget and cpu budget.** These bound the backends registered in THIS process. The
  cross-replica truth for placement capacity is the orchestrator itself: `capacity()` live-probes Nomad/K8s
  and the scheduler already reconciles `used = max(probe, ownInFlight)`, so a second replica's jobs are seen
  through the cluster, not through a shared counter.
- **Per-harness (session pool) admission.** `CaseCapacityAware.capacityFor` reads the deployed service's own
  pool, which is shared infrastructure — the reading already includes other replicas' held sessions, and the
  local count only guards over-admission within a single drain.
- **Browser process caps.** `browser-session-service.ts`'s global cap bounds one node's browser processes.
- **In-process caches and rendezvous with no store twin** (live traces, the in-memory runner hub). Live
  trace reads are best-effort by contract; the runner hub has a store-backed twin that multi-replica
  deployments must enable (below).

## Operator checklist for N > 1

1. `DATABASE_URL` — required. Without Postgres there is no ledger, no lease and no heartbeat: every replica
   is its own island, exactly as before.
2. `EVERDICT_SELF_HOSTED_STORE_HUB=1` — self-hosted runner jobs are parked and leased through the Pg claim
   queue (`everdict_runner_jobs`, migration 0055) instead of the in-process hub. Left off, a job parked on
   one replica is invisible to a runner leasing from another.
3. `EVERDICT_CALLBACK_BASE_URL` — front-door callbacks already rendezvous through the store; the URL must
   address the load balancer, not one replica.
4. Migrations run once (they are idempotent and tracked), not per replica boot.

## Out of scope

The Temporal worker (`packages/orchestrator/src/worker.ts`) builds its **own** `Scheduler` over its own
registry in a separate process. It is not an api replica and shares no backend roster with one, so
cross-replica admission does not apply to it; the durable workflow state is what keeps its work single-owner.
Full distributed fair queueing (a shared WFQ across replicas) is also out of scope — fairness stays
per-replica, and the quota is what stops one workspace from consuming the fleet.
