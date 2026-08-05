# Usage metering — the billing surface (meter-only, durable)

> SSOT for how Everdict meters the billable surface. Companion to `one-call-sdk.md` (the pricing position).

## What is metered

The billable surface is **orchestration + verdict LLM cost** — the LLM cost of the harness under test, the
eval/judge model, and agent conversations — **not resold compute**. Compute is BYO: a **personal self-hosted
(own-pays) run is excluded** (the tenant paid their own login directly) — **except** calls that used a
**workspace-designated model** (a registered Model whose API key resolves from the workspace secret tier: the
workspace paid for those tokens, so they ARE metered against it). This is the "your infra, our verdict" position,
refined so the workspace is billed for exactly the model tokens it actually paid for.

The chosen model (maintainer decision): meter **LLM cost** (usd + tokens, plus an evaluations count), **metering
only** — it **never blocks** a run (distinct from the enforcement `BudgetTracker`, whose `admit()` throws 402).

## The meter (`@everdict/domain` `UsageMeter`)

- `record(tenant, source, model, cost, evaluations?, day?)` — accumulate cost against a tenant + source (`harness` |
  `judge` | `agent`) + model + **UTC day** (defaults to today; `usageDay()`), so usage is itemizable as a
  **(source × model)** matrix AND chartable as a **per-day spend series**.
- attribution = `billingCharges(result, originalTenant)` (`@everdict/domain`): splits the trace cost per model and
  routes each slice — managed / workspace-shared runner → the whole cost bills to that tenant; a personal
  self-hosted (own-pays) run bills the workspace only for calls on a **workspace-billed model** (from
  `provenance.billedModels`, stamped at dispatch by `ModelResolvingDispatcher` when the key came from the workspace
  secret tier). One case = one metered evaluation (carried on a single charge line).
- `usage(tenant)` — totals + a per-source split + a per-`(source × model)` `items` breakdown + a `daily`
  per-`(day × source × model)` series (oldest first; the pre-itemization legacy bucket is in the totals but not the
  series). Synchronous (fast reads for `GET /usage`).

Every settle site (`ScorecardService` per case + `RunService` per single run) loops `billingCharges` and, for each
line, records it (meter, best-effort — `.catch(() => {})`, never blocks) **and** settles the enforcement budget — so
the meter and the 402-cap always agree. `GET /usage` + `get_usage` (MCP) expose it (viewer+, reuses `scorecards:read`).

## Durability — write-through + boot hydration (`@everdict/db` `UsageStore`)

The meter is **in-memory for reads** (sync, single-process source of truth — same assumption as `BudgetTracker`),
made durable by a **write-through** to a `UsageStore`:
- `UsageStore.record(...)` — an **atomic per-(tenant, source, model, day) increment** (`ON CONFLICT DO UPDATE SET
  usd = usd + …`), so concurrent writes accumulate correctly. Table `everdict_usage` (mig 0051; the `model`
  dimension added in mig 0081; the `day` dimension in mig 0088 — pre-existing lifetime rows keep the `1970-01-01`
  sentinel, so totals stay correct and the daily chart simply starts at the migration; all additive).
- `persistentUsageMeter(store)` (`apps/api/src/common/usage-meter.ts`) wraps the in-memory meter: every `record`
  also fires a **best-effort** `store.record` (a failed persist never blocks or fails metering) with the day
  **stamped once** (meter and store agree across a midnight boundary), and `hydrate()` loads all rows back into
  memory at boot so usage **survives a restart**.
- `main.ts` uses `persistentUsageMeter(new PgUsageStore(client))` (or `InMemoryUsageStore` with no `DATABASE_URL`)
  and `await usageMeter.hydrate()` at startup.

## Agent conversations (source `agent`)

A harness reports its own `total_cost_usd` in its trace; the **agent loop yields TOKENS only**. So agent cost is
metered over a small bridge:
- The kernel fires `onUsage(LlmUsage)` per model turn (`@everdict/agent-runtime` `loop.ts`); `apps/agent` `runChat`
  accumulates the conversation's input/output tokens plus the prompt-cache split (`cacheReadTokens` /
  `cacheWriteTokens` — subsets of `inputTokens`, which the transports report as the full prompt footprint).
- After the turn, **only when the model was workspace-billed** (the API key came from the workspace secret tier —
  `ResolvedModel.billed`, the same rule as the harness), the agent server POSTs `{tenant, source:"agent", model,
  inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}` to `POST {CONTROL_PLANE_URL}/internal/usage`
  (`x-internal-token` = `CONTROL_PLANE_INTERNAL_TOKEN`). Own-pays / personal-key / dev conversations are not
  metered. Best-effort — a failed report never breaks the chat.
- The control plane **prices** the tokens (`priceUsd`, `@everdict/domain` `billing/pricing.ts` — approximate public
  list prices, `$0` for an unknown model; tokens are exact) and `record`s + `settle`s them against the workspace, so
  agent cost lands in the SAME meter + enforcement budget as evals, itemized under model × `agent`. Cache tokens
  price at their own rates (Anthropic: read = 0.1x input, write = 1.25x; OpenAI cached input at half rate) — without
  the split every cached read would bill at the full input price.
- **Known limits**: pricing is approximate (operator-adjustable); a mid-run `fallback`/`subagent` model tier is
  attributed to the main model (its usage still flows through `onUsage`).

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
- The web billing view lives on Settings › Budget (`/[workspace]/settings/budget`; the old `/usage` route
  redirects there): metered usage first — month-to-date + all-time tiles, a **daily-spend stacked-column chart**
  (7/30/90-day range, grouped by activity or by model, fed by `daily`) and the all-time (source × model) breakdown
  table — with the enforcement caps below.
