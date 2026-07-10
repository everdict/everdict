# Rich domain core — the domain expresses itself (design)

> **Status: S0-S4 SHIPPED** (`466efdc`→`0941840`; 706/706 tests + build + boot contract at every slice).
> S1 `a3afa12`: **Run** model (newQueued the only construction path; isTerminal/canAdopt/canRedispatch;
> succeed/fail/adopt/redispatch return store patches; the service's read-guarded `finalize` = first terminal
> write wins — 2 races sealed by regressions). S2 `30beb3a`: **ScorecardBatch** aggregate (34 inline status
> sites mapped to factories/guards/transitions; the "latest child per case" seed helper unified across THREE
> copies; child writes reuse the Run model; trialSummary derivation on the model; 4 races sealed — late
> success/failure over a raced supersede, planBatch/finalizeBatch superseded-revive). S3 `7bb06c4`:
> **MembershipPolicy** (last-admin ×3 → intent-named guards over one predicate; invite wrapper deliberately
> skipped — the store's consume CTE is the atomic SSOT). S4 `0941840`: **Schedule** model (cron at birth,
> content-vs-pause edit permission, autoDisable transition; bookkeeping stamps deliberately left plain;
> Temporal rollback failure now surfaces `{rollbackFailed}` instead of a silent swallow).
>
> Maintainer-directed Round 6 over the api-layer re-architecture: the control-plane core was an anemic
> domain — records were behavior-less Zod data, state transitions scattered inline mutations, and invariants
> lived in services. This round gives each domain a model that owns its lifecycle.

## Problem — measured

- `ScorecardRecord.status` is written at **18+ sites across three services** (batch/ingest/facade), mostly
  unguarded — a terminal record can be blindly re-written. Terminal-state checks and the "latest child per
  case" seed algorithm are duplicated 2-3×; trialSummary/ETA/child-run hydration are derived inline in
  `get()`.
- `RunRecord.status` is written at 5 sites; the track loop's succeeded/failed writes are unguarded (a race
  lets the later write win).
- 13 business invariants live inline in services/routes (last-admin protection ×3 duplicate sites,
  retry-failed terminal gate, resume eligibility, invite single-use/expiry, cron validity, …).
- Every record type is pure data (`z.infer`); services assemble them with object literals.

## The idiom (reinterpreted from the proven layered-service source)

The source codebase's core layer makes the domain express itself: entities hold immutable identity and
mutable state behind private setters; mutation goes through domain methods that throw on illegal transitions
(`update(patch)` rejecting a clear of a required field); **state-guard methods** say what is legal
(`invitation.canAccept() = PENDING && !expired`); repository boundaries convert entity↔domain privately; a
cross-service read concern gets a **policy component** (visibility policy with a batched `canViewAll` — the
answer to "services never call services"); services keep orchestration only (idempotency, cross-domain
composition, events, transaction boundaries).

TypeScript reinterpretation — no JPA dirty-checking exists, and stores persist partial patches, so a domain
mutation method **guards the transition and returns the store patch**:

```ts
// core/run/run.ts — the domain model wraps the persistence record
export class Run {
  private constructor(private readonly record: RunRecord) {}
  static from(record: RunRecord): Run { return new Run(record); }
  static newQueued(input: …): RunRecord { /* the only place a queued run is assembled */ }

  isTerminal(): boolean { … }
  canAdopt(): boolean { … }

  start(): RunUpdate { /* queued→running; anything else throws ConflictError from the DOMAIN */ }
  succeed(result: CaseResult): RunUpdate { /* terminal re-write throws — first terminal write wins */ }
  fail(error: ErrorEnvelope): RunUpdate { … }
}

// the service orchestrates; it never writes a status literal again:
const run = Run.from(await store.get(id) ?? raise());
await store.update(id, run.succeed(result));
```

- **Records stay in `@everdict/db`** (persistence contract, unchanged wire/DB shapes). The model is the
  behavior wrapper; `from(record)` / returned patches are the conversion boundary.
- **Transitions throw from the domain** (`ConflictError`/`BadRequestError` subclasses of `AppError`) — the
  service maps them like any other failure; HTTP semantics stay derived from the error type.
- **Guard methods are the SSOT for legality** (`isTerminal`, `canResume`, `canRetryFailed`, `canAdopt`) —
  services and transports ask, never re-derive from status literals.
- **Policies** (`core/<domain>/<x>-policy.ts`) own cross-service read/invariant concerns that would otherwise
  be duplicated (membership last-admin rule) — plain classes over stores, batched lookups where lists are hot.
- **Guarding is a deliberate behavior change** at previously-unguarded race sites: the old code let the last
  write win; the model makes the first terminal write win and the loser a no-op/logged skip. Each such site
  ships a regression test pinning the new semantics.

## Slices (green-gated, one commit each)

1. **S1 — Run (pilot).** `core/run/run.ts` + unit tests; run-service's 5 sites rewire (submit assembly via
   `newQueued`, resume adopt/redispatch via guards, track terminal writes read-guard-update). Regression: a
   late `fail` cannot overwrite `succeeded`.
2. **S2 — ScorecardBatch (the beast).** `core/scorecard/scorecard-batch.ts` aggregate: lifecycle
   (queued→running→succeeded|failed|superseded), `isTerminal/canResume/canRetryFailed/canSupersede`, the
   unified "latest child per case" seed helper, supersede rules, trialSummary/ETA derivations as read methods.
   The 18+ mutation sites across batch/ingest/facade all route through it.
3. **S3 — Membership policy + Invite.** `core/member/membership-policy.ts` owns the last-admin invariant
   (one implementation, three call sites); invite lifecycle guards wrap the consume semantics.
4. **S4 — Schedule.** Cron/lifecycle guards + Temporal-sync outcome handling (`ensure` failure → rollback is
   accounted for, not `.catch(() => {})`).

Gates per slice: new domain unit tests (English BDD) + the full apps/api suite + build + empty-env boot
contract. Non-goals (explicitly deferred, separate rounds if ever): the source idiom's `Patch<T>`
three-state partial-update system; idempotency keys for run submission.
