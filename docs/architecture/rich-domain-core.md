---
kind: wiki
title: "Rich domain core — the domain expresses itself (design)"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/run/run.ts, packages/domain/src/scorecard/scorecard-batch.ts, packages/domain/src/member/membership-policy.ts, packages/domain/src/schedule/schedule.ts]
---
# Rich domain core — the domain expresses itself (design)

> **Shipped** in four slices (`a3afa12` Run · `30beb3a` ScorecardBatch · `7bb06c4` MembershipPolicy · `0941840`
> Schedule), each sealing the races it found with regression tests. The models were written in `apps/api` and
> moved to `@everdict/domain` by the re-architecture; this page records the idiom and why it exists.

## Problem — what it replaced

The control-plane core was an anemic domain: records were behavior-less Zod data, state transitions were
scattered inline mutations, and invariants lived in services. Measured before the change:

- `ScorecardRecord.status` was written at **18+ sites across three services** (batch/ingest/facade), mostly
  unguarded — a terminal record could be blindly re-written. Terminal checks and the "latest child per case" seed
  algorithm were duplicated 2–3×.
- `RunRecord.status` was written at 5 sites; the track loop's succeeded/failed writes were unguarded, so a race
  let the later write win.
- 13 business invariants lived inline in services and routes (last-admin protection ×3, retry-failed terminal
  gate, resume eligibility, invite expiry/revocation, cron validity, …).

## The idiom

Reinterpreted from the proven layered-service source: entities hold their state behind domain methods that throw
on illegal transitions, **state-guard methods** say what is legal (`invitation.canAccept() = PENDING &&
!expired`), a cross-service invariant gets a **policy** component, and services keep orchestration only
(idempotency, cross-domain composition, events, transaction boundaries).

TypeScript has no JPA dirty-checking and stores persist partial patches, so a domain transition **guards, then
returns the store patch together with the facts it produces**:

```ts
// packages/domain/src/run/run.ts
export interface RunTransition { patch: Partial<RunRecord>; facts: DomainFact[] }

export class Run {
  static from(record: RunRecord): Run { … }
  static newQueued(input: NewQueuedRunInput): RunRecord { /* the only place a queued run is assembled */ }

  isTerminal(): boolean { … }
  canAdopt(): boolean { … }
  canRedispatch(): boolean { … }

  start(now: string): RunTransition { /* queued→running; refused once terminal */ }
  succeed(result: CaseResult, now: string, declared?: SettleDeclaration): RunTransition { … }
  fail(…): RunTransition { … }
}

// the service orchestrates; it never writes a status literal (session/turn-finalize.ts):
await finalizeRun(deps, id, tenant, (run) => run.succeed(result, now)); // CAS-guarded: first terminal write wins
```

- **Records live in `@everdict/contracts`** (`packages/contracts/src/records/`) with unchanged wire and DB shapes.
  The model is the behavior wrapper; `from(record)` and the returned transition are the conversion boundary. A
  transition is never spread — `{...transition}` drops both halves past the type checker; use `.patch`.
- **Transitions throw from the domain** (`ConflictError` / `BadRequestError`, both `AppError` subclasses); the
  service maps them like any other failure, and HTTP status still derives from the error type.
- **Guard methods are the source of truth for legality** (`isTerminal`, `canResume`, `canRetryFailed`,
  `canAdopt`, `canSupersede`, …): services and transports ask, never re-derive from status literals.
- **Policies** (`packages/domain/src/<domain>/<x>-policy.ts`) own invariants that would otherwise be duplicated.
  `MembershipPolicy` is a plain class over a member list the service already fetched — injecting the store would
  only duplicate the read.
- **Guarding is a deliberate behavior change** at previously unguarded race sites: the old code let the last write
  win; the model makes the first terminal write win and the loser a no-op or logged skip, and each such site has a
  regression test pinning it.

## The models

| Model | File | What it owns |
|---|---|---|
| **Run** | `packages/domain/src/run/run.ts` (+ per-kind modules `session-run.ts`, `agent-run.ts`, `command-run.ts`) | `newQueued` and the other birth factories; `isTerminal` / `canAdopt` / `canRedispatch`; `start` / `succeed` / `fail` / `adopt` / `redispatch` |
| **ScorecardBatch** | `packages/domain/src/scorecard/scorecard-batch.ts` | lifecycle (queued → running → succeeded \| failed \| superseded \| cancelled); `canResume` / `canRetryFailed` / `canSupersede` / `canCancel`; the unified canonical-child-per-case helper; trial-summary derivation |
| **MembershipPolicy** | `packages/domain/src/member/membership-policy.ts` | the last-admin invariant behind three intent-named guards (demotion, removal, leave). Invite consumption was deliberately left to the store's atomic consume query |
| **Schedule** | `packages/domain/src/schedule/schedule.ts` | cron validity at birth, the content-vs-pause edit permission, the Temporal spec, `autoDisable`. Plain bookkeeping stamps stay literal in the service; a failed Temporal rollback surfaces as `rollbackFailed` instead of being swallowed |

Services that use them live in `packages/application-control` (`run/run-service.ts`,
`scorecard/`, `schedule/schedule-service.ts`, …).

Non-goals, still not built: the source idiom's `Patch<T>` three-state partial-update system; idempotency keys for
run submission.
