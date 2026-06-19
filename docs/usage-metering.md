# Usage metering (gateway sidecar)

**Decision (operating model):** model gateways (e.g. LiteLLM) are **BYO** — a workspace/harness points at its own
endpoint; Assay does **not** mandate one. **Budget stays Assay-owned** (`BudgetTracker`). To still learn what a
**black-box harness** spent (aider with `trace:none` reports nothing), Assay can put a tiny **usage proxy** in
front of the BYO endpoint and recover token usage per run.

## Why a proxy (evidence)
We probed the workclaw LiteLLM directly:
- `chatgpt/gpt-5.4-mini` is a **ChatGPT-subscription** model → LiteLLM has no price → per-key **`spend = 0`**,
  and `/spend/logs` is empty. So "read cost from the gateway" yields **0** for these models.
- But every call's response carries **`usage`** (prompt/completion/total tokens) — e.g. 1644 tokens — in the
  **body**, and the **per-call cost** in a response **header** (`x-litellm-response-cost` /
  `x-litellm-response-cost-original`; `0.0` for subscription models, a real `$` for metered ones).
The only place tokens/cost exist for a black-box harness is the **response**, which the harness discards. A
forwarding proxy that Assay owns can read both. (This is the "uniform cost/token capture via an LLM-proxy" from
the original architecture.) **Tokens always; `$` when the gateway prices the model** (subscription → `$0`).

## Mechanism (`@assay/trace`)
`createUsageProxy({ upstreamBaseUrl, runHeader?, defaultRunId?, tally? })` → `{ server, tally }` (and
`startUsageProxy(...)` → listens on `127.0.0.1:0` → `{ url, tally, close }`):
- A reverse proxy: forwards `/v1/*` to the BYO upstream **verbatim** (request + response bodies unchanged).
- On each JSON response it parses `usage` (`extractUsage`, body) **and** the cost header (`costFromHeaders`) and
  tallies by **run** — run id from the `x-assay-run` header (stripped before forwarding, never leaks upstream) or
  `defaultRunId` (per-run proxy instance). `inMemoryUsageTally()` keeps
  `{promptTokens, completionTokens, totalTokens, usd, calls}` per run.

## Wired into the run lifecycle (per-workspace / per-run)
The proxy lives **in the agent's sandbox**, on `localhost` — so it works on every backend (Local/Nomad/K8s)
without any cross-network reconfiguration (the agent→upstream path is the one that already works):
1. **Control plane decides** whether to meter a run and sets **`AgentJob.meterUsage`** (authoritative).
   Resolution in `RunService` (async): per-run override (`POST /runs` body `meterUsage`) → per-workspace policy
   (`meterUsageFor(tenant)`) → `false`. `main.ts` wires the policy as **durable per-workspace settings → env
   fallback**: `(await settingsStore.get(tenant))?.meterUsage ?? envPolicy(tenant)`, where the
   `WorkspaceSettingsStore` (`@assay/db`, InMemory/Pg, table `assay_workspace_settings`) is managed by admins via
   **`PUT/GET /workspace/settings`** (`settings:write`/`settings:read`, admin-only), and `envPolicy` is the
   default from **`ASSAY_METER_TENANTS`** (comma list) or **`ASSAY_METER_USAGE=1`** (all).
2. `runAgentJob` uses `job.meterUsage` (falls back to the `ASSAY_METER_USAGE` env only for direct
   `LocalBackend.dispatch` with no control plane) → passes `meterUsage` to `makeHarness`.
3. `CommandHarness.run` (only when `trace:none` + the model-base env var is present — avoids double-counting a
   harness that already reports its own cost) starts a per-run `startUsageProxy(upstream = OPENAI_API_BASE)`,
   **rewrites `OPENAI_API_BASE` to the proxy**, runs the command (aider/any CLI — **zero harness code**), then
   emits the captured tokens **and cost** as a synthetic **`llm_call`** trace event (`cost: { inputTokens,
   outputTokens, usd }` — `usd` from the gateway cost header, `0` for subscription models).
4. That event rides `runCase` → `result.trace`, so the **existing** path settles it: `RunService.track` already
   does `budget.settle(tenant, costOf(result))` and persists `result` in the `RunStore`. No RunService change.
5. **Surfaced on the run record:** `RunStore` get/list/update return `RunRecord.usage`
   (`{promptTokens, completionTokens, totalTokens, usd, calls}`), **derived** from `result.trace` via
   `usageFromTrace` (`@assay/core`) on read — no column, no migration, always consistent. Clients (API/MCP/web)
   read `record.usage` without parsing the trace.

## Verified
- Deterministic (`packages/trace/src/usage-proxy.test.ts`): `extractUsage` (incl. `total` fallback, null on
  no-usage/non-JSON); `costFromHeaders` (both header names, non-numeric → 0); proxy **passthrough** (body
  unchanged), **per-run** token **and `$`** accumulation (cost header → `usd`), run header **not leaked**
  upstream, header-less → `default`.
- Deterministic (`packages/harnesses/src/command.test.ts`): `meterUsage` rewrites the base to the proxy, emits
  the synthetic `llm_call` with the captured tokens **and `usd`**, and closes the proxy; **not** metered when
  `trace` ≠ `none`.
- Deterministic (`apps/api/src/run-service.test.ts`): resolution order — per-run override > per-workspace policy
  > off — and the decided value is carried on `AgentJob.meterUsage`.
- Live proxy (`scripts/live/usage-proxy.mjs`) vs real workclaw LiteLLM `gpt-5.4-mini`: `run-A` = 2 calls / 3276
  tokens, `run-B` = 1 call / 1642 tokens — captured while responses pass through intact.
- Live lifecycle (`scripts/live/usage-proxy-run.mjs`): a `command` harness dispatched via `LocalBackend` with
  `ASSAY_METER_USAGE=1` → `result.trace` carries `llm_call` `{inputTokens: 1637, outputTokens: 6, usd: 0}` →
  `sumCost = { usd: 0, tokens: 1643 }` (the exact value `budget.settle` receives). Subscription model = `$0`,
  yet **tokens are metered**.

## Not yet (next)
- Web/MCP surface for `PUT /workspace/settings` (today: HTTP route + `can()` mirror; no web page yet).
- Note: `$` capture is **live-ready** but reads `0` on workclaw's LiteLLM because its models are subscription
  (unpriced); it yields real `$` for any metered model the gateway prices.
