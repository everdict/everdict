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

## Mechanism (`@assay/backends`)
`createUsageProxy({ upstreamBaseUrl, runHeader?, defaultRunId?, tally? })` → `{ server, tally }`:
- A reverse proxy: forwards `/v1/*` to the BYO upstream **verbatim** (request + response bodies unchanged).
- On each JSON response it parses `usage` (`extractUsage`) and tallies tokens by **run** — run id from the
  `x-assay-run` header (stripped before forwarding, never leaks upstream) or `defaultRunId` (per-run proxy
  instance). `inMemoryUsageTally()` keeps `{promptTokens, completionTokens, totalTokens, calls}` per run.
- The harness only needs `OPENAI_API_BASE` → the proxy. **Zero harness code** (works for aider, any
  OpenAI-compatible CLI). The tokens feed Assay's existing budget: `budget.settle(tenant, { usd: 0, tokens })`.

## Verified
- Deterministic (`packages/backends/src/usage-proxy.test.ts`): `extractUsage` (incl. `total` fallback,
  null on no-usage/non-JSON); proxy **passthrough** (body unchanged), **per-run** token accumulation, run
  header **not leaked** upstream, header-less → `default`.
- Live (`scripts/live/usage-proxy.mjs`) against the real workclaw LiteLLM `gpt-5.4-mini`: `run-A` = 2 calls /
  3276 tokens, `run-B` = 1 call / 1642 tokens — captured through the proxy while responses pass through intact.
  (A subscription model reports `$0`, yet **tokens are metered** — exactly the gap this closes.)

## Not yet (next)
- Wire the proxy into the run lifecycle (RunService/agent): inject `OPENAI_API_BASE`=proxy + `x-assay-run`, then
  `budget.settle` with captured tokens and store `RunUsage` on the run record.
- $ capture for metered models (upstream cost header) — tokens-only by decision for now.
