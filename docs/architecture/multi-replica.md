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
| Boot recovery | Record ownership + replica heartbeats — a boot reclaims only work whose driver is gone |
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

The snapshot read is the cheap **pre-filter** (HOL avoidance — skip work that plainly has no headroom
without paying a write), and best-effort: a ledger that cannot answer falls back to this replica's own
counts for the pre-filter. **The limit itself is the atomic permit** (`AdmissionLedger.tryAdmit`, mig 0139):
before committing a quota'd job to dispatch, the scheduler claims one slot on the tenant's counter row —
one `UPDATE … SET in_flight = in_flight + 1 WHERE tenant = $1 AND in_flight < $quota`, whose predicate
re-evaluates on the LATEST row version under the row lock (READ COMMITTED's update re-check; a count-then-
insert, with or without an advisory lock, keeps its statement-start snapshot after unblocking and races).
Two replicas admitting in the same instant therefore serialize on the row, and the quota holds fleet-wide
**at every instant, not eventually** (TRUST-07 certifies the simultaneous race against real Postgres). Each
admission also writes a job-keyed permit row, released at settle (idempotent). A permit-claim ERROR is
fail-closed for quota'd work — the job stays queued for the next drain — because admitting on "could not
check" is how a guarantee becomes a suggestion; unquota'd tenants never touch the permit path.

**Conservation.** The counter's invariant is `in_flight == live permit rows`, at every step, under every
failure. Two protocol rules keep it: a **retry with the same permit id is the same right** — the claim
answers an existing permit as "held" and its counter arm is guarded on the permit's absence, so a
lost-response retry can never increment twice (the pre-fix shape left a PERMANENT phantom: release
decremented once and the reap, with no row left, never recovered it) — and every path that drops a queued
entry also releases its permit, because a claim that committed behind a lost response is a real permit
behind a refusal this replica saw. The fleet-admission trust scenarios certify conservation against real
Postgres; note the in-memory twin CANNOT reproduce counter drift (its count is derived from the permit set
— the ideal the Pg counter approximates), so Pg-backed tests are the only authority here.

**The permit is a lease, not a timestamp** (mig 0140). The scheduler renews the permits its in-flight work
holds on a heartbeat (default 10 min, `permitRenewMs`), and the reap — a global sweep on any admission, so
an idle tenant's leaks still heal — frees only permits whose `renewed_at` lapsed the 30-minute lease
window. A replica that dies stops renewing and its leak heals in at most the window (**throttling** its
tenant briefly); a healthy long run renews forever and is never reaped — the wall-clock TTL this replaced
reaped healthy permits out from under running compute, which **inflated** the quota, the direction the
ledger exists to close.

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

### Recovery (S3)

`recoverInterrupted` resumes or tombstones every `queued`/`running` record it finds, on the single-control-plane
assumption its own header used to state. Across replicas that is a boot settling work another replica is
actively driving, which is the sharpest hazard on this list: it kills live batches.

Two facts make it decidable. Records carry `ownerReplica`, stamped by the STORE at insert — the process that
writes the row is the process about to drive it, so ownership needs no submit path to thread it and no caller
can forge it — and every replica writes a heartbeat into `everdict_control_plane_replicas`. Recovery reclaims
a record only when its owner is absent from the live set, re-stamps whatever it claims as its own (or the next
boot would take it back from the replica now driving it), and reports what it deliberately left alone. A record
with no owner — written before the column existed, or by the in-memory store — keeps the old unconditional
behavior. An unreadable heartbeat set is treated as "everyone may be alive": leaving a stale record for the
next boot is recoverable, killing a live batch is not.

Recovery deliberately runs on EVERY replica rather than only the leader: it is what reclaims a dead
predecessor's work, and gating it on leadership would leave that work stranded until the leader happened to
restart. Ownership is the precise guard; leadership would only have been a coarse one. The residual race is
narrow and documented — two replicas booting in the same instant can both claim the same dead owner's record.

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
   `EVERDICT_REPLICA_ID` may pin this process's identity for log correlation, but it MUST be unique per
   replica — two replicas sharing one id look like one process to both the lease and the heartbeat.
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
