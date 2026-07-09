# Usage metering — the billing surface (meter-only, durable)

> SSOT for how Everdict meters the billable surface. Companion to `one-call-sdk.md` (the pricing position).

## What is metered

The billable surface is **orchestration + verdict LLM cost** — the LLM cost of the harness under test and the
eval/judge model — **not resold compute**. Compute is BYO: a **personal self-hosted (own-pays) run is excluded**
(the tenant paid their own login directly). This is the "your infra, our verdict" position enforced at the meter.

The chosen model (maintainer decision): meter **LLM cost** (usd + tokens, plus an evaluations count), **metering
only** — it **never blocks** a run (distinct from the enforcement `BudgetTracker`, whose `admit()` throws 402).

## The meter (`@everdict/backends` `UsageMeter`)

- `record(tenant, source, cost, evaluations?)` — accumulate cost against a tenant + source (`harness` | `judge`).
- `meterCase(result, originalTenant)` — meter a completed case's harness LLM cost (`costOf`), attributed via
  `billingTenant` (own-pays → skipped).
- `usage(tenant)` — totals + a per-source split. Synchronous (fast reads for `GET /usage`).

The scorecard pipeline calls `meterCase` at each settle site (best-effort — `.catch(() => {})`, never blocks the
batch). `GET /usage` + `get_usage` (MCP) expose it (viewer+, reuses `scorecards:read`).

## Durability — write-through + boot hydration (`@everdict/db` `UsageStore`)

The meter is **in-memory for reads** (sync, single-process source of truth — same assumption as `BudgetTracker`),
made durable by a **write-through** to a `UsageStore`:
- `UsageStore.record(...)` — an **atomic per-(tenant, source) increment** (`ON CONFLICT DO UPDATE SET usd = usd +
  …`), so concurrent writes accumulate correctly. Table `everdict_usage` (mig 0051, additive).
- `persistentUsageMeter(store)` (`apps/api/src/lib/usage-meter.ts`) wraps the in-memory meter: every `record` also
  fires a **best-effort** `store.record` (a failed persist never blocks or fails metering), and `hydrate()` loads
  all rows back into memory at boot so usage **survives a restart**.
- `main.ts` uses `persistentUsageMeter(new PgUsageStore(client))` (or `InMemoryUsageStore` with no `DATABASE_URL`)
  and `await usageMeter.hydrate()` at startup.

### Deliberate limits
- **Single-process read model**: reads come from the process's in-memory accumulator (hydrated at boot). With
  several control-plane replicas each keeps its own in-memory view; the durable table is the union. Cross-replica
  read aggregation (async `usage()` from the store) is a follow-up if multi-writer billing reads are needed — the
  same limitation the in-memory `BudgetTracker` already has.
- **Best-effort persistence**: a crash between the last `store.record` and the next can lose a few increments.
  Acceptable for meter-only usage; upgrade to transactional settle if strict billing is required.

## Follow-ups
- Judge-model cost capture: `JudgeCompletion` currently returns `Promise<string>` (discards token usage) — capturing
  judge cost means threading usage through the grader transport (`anthropicComplete`/`openaiComplete` → `modelJudge`
  → `judge-runner` → scoring). Deep/invasive; the harness dominates cost (judge = one call per case), so low priority.
- A web usage view already exists (`/[workspace]/usage`).
