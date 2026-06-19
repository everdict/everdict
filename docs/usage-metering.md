# Usage metering (gateway sidecar)

**Decision (operating model):** model gateways (e.g. LiteLLM) are **BYO** — a workspace/harness points at its own
endpoint; Assay does **not** mandate one. **Budget stays Assay-owned** (`BudgetTracker`). To still learn what a
**black-box harness** spent (aider with `trace:none` reports nothing), Assay can put a tiny **usage proxy** in
front of the BYO endpoint and recover token usage per run.

## Why a proxy (evidence)
We probed the workclaw LiteLLM directly:
- `chatgpt/gpt-5.4-mini` is a **ChatGPT-subscription** model → LiteLLM has no price → per-key **`spend = 0`**,
  and `/spend/logs` is empty. So "read cost from the gateway" yields **0** for these models.
- But every call's response carries **`usage`** (prompt/completion/total tokens) — e.g. 1644 tokens.
The only place tokens exist for a black-box harness is the **response body**, which the harness discards. A
forwarding proxy that Assay owns can read it. (This is the "uniform cost/token capture via an LLM-proxy" from the
original architecture.) Token metering first; $ later (metered models, via the upstream's
`x-litellm-response-cost` header).

## Mechanism (`@assay/trace`)
`createUsageProxy({ upstreamBaseUrl, runHeader?, defaultRunId?, tally? })` → `{ server, tally }` (and
`startUsageProxy(...)` → listens on `127.0.0.1:0` → `{ url, tally, close }`):
- A reverse proxy: forwards `/v1/*` to the BYO upstream **verbatim** (request + response bodies unchanged).
- On each JSON response it parses `usage` (`extractUsage`) and tallies tokens by **run** — run id from the
  `x-assay-run` header (stripped before forwarding, never leaks upstream) or `defaultRunId` (per-run proxy
  instance). `inMemoryUsageTally()` keeps `{promptTokens, completionTokens, totalTokens, calls}` per run.

## Wired into the run lifecycle (opt-in)
The proxy lives **in the agent's sandbox**, on `localhost` — so it works on every backend (Local/Nomad/K8s)
without any cross-network reconfiguration (the agent→upstream path is the one that already works):
1. `runAgentJob` reads **`ASSAY_METER_USAGE=1`** → passes `meterUsage` to `makeHarness`.
2. `CommandHarness.run` (only when `trace:none` + the model-base env var is present — avoids double-counting a
   harness that already reports its own cost) starts a per-run `startUsageProxy(upstream = OPENAI_API_BASE)`,
   **rewrites `OPENAI_API_BASE` to the proxy**, runs the command (aider/any CLI — **zero harness code**), then
   emits the captured tokens as a synthetic **`llm_call`** trace event (`cost: { inputTokens, outputTokens,
   usd: 0 }`).
3. That event rides `runCase` → `result.trace`, so the **existing** path settles it: `RunService.track` already
   does `budget.settle(tenant, costOf(result))` and persists `result` in the `RunStore`. No RunService change.

## Verified
- Deterministic (`packages/trace/src/usage-proxy.test.ts`): `extractUsage` (incl. `total` fallback, null on
  no-usage/non-JSON); proxy **passthrough** (body unchanged), **per-run** token accumulation, run header **not
  leaked** upstream, header-less → `default`.
- Deterministic (`packages/harnesses/src/command.test.ts`): `meterUsage` rewrites the base to the proxy, emits
  the synthetic `llm_call` with the captured tokens, and closes the proxy; **not** metered when `trace` ≠ `none`.
- Live proxy (`scripts/live/usage-proxy.mjs`) vs real workclaw LiteLLM `gpt-5.4-mini`: `run-A` = 2 calls / 3276
  tokens, `run-B` = 1 call / 1642 tokens — captured while responses pass through intact.
- Live lifecycle (`scripts/live/usage-proxy-run.mjs`): a `command` harness dispatched via `LocalBackend` with
  `ASSAY_METER_USAGE=1` → `result.trace` carries `llm_call` `{inputTokens: 1637, outputTokens: 6, usd: 0}` →
  `sumCost = { usd: 0, tokens: 1643 }` (the exact value `budget.settle` receives). Subscription model = `$0`,
  yet **tokens are metered**.

## Not yet (next)
- Per-workspace/run control of metering (instead of the global `ASSAY_METER_USAGE` flag).
- $ capture for **metered** models (upstream `x-litellm-response-cost` header) — tokens-only by decision for now.
- Optional explicit `RunUsage` summary on the `RunRecord` (today it's derivable from `result.trace`).
