# Assay

Harness-agnostic, infra-agnostic **agent evaluation runtime**. Register & version any agent harness —
a CLI (Claude Code, Codex) or a multi-service topology (browser-use LangGraph) — run it across
environments (repo / browser / os-use) and orchestrators (Nomad / K8s / local), and **score** it
fairly, repeatably, with regression tracking. Eval-first; just enough operational runtime to drive
long, stateful, isolated runs. **Fully self-hosted** — no vendor sandbox; isolation comes from your own
Nomad/K8s (gVisor/Kata).

## The spine
A run separates four in-sandbox concerns + a placement layer:
**Harness** (under test) · **Environment** (the world it acts on) · **Driver** (in-sandbox compute) ·
**Grader** (how we judge) · **Backend** (where it's placed: Nomad / K8s / local).

## Architecture (one-way deps)
```
core ← { drivers · environments · harnesses · graders · trace } ← runner ← agent ← backends ← { orchestrator · topology } ← apps/cli
```

## Packages
| Package | Role |
|---|---|
| `@assay/core` | contracts (interfaces + Zod + errors). Dependency root. |
| `@assay/drivers` | in-sandbox compute (`LocalDriver`). |
| `@assay/environments` | the world a run acts on (`RepoEnvironment`). |
| `@assay/harnesses` | the agent under test (`ClaudeCodeHarness`, `ScriptedHarness`) + stream-json→trace. |
| `@assay/graders` | scoring (tests-pass / cost / steps / latency). |
| `@assay/runner` | the eval loop (`runCase`). |
| `@assay/agent` | the dispatched unit (model B): runs `runCase` in an isolated job. |
| `@assay/backends` | placement: `Backend` (Local, Nomad, K8s) + `Router` (static) / `Scheduler` (capacity-aware) / `BackendRegistry`. |
| `@assay/orchestrator` | durable control plane on Temporal (Direct / Temporal + worker). |
| `@assay/trace` | pull a harness trace from OTel/MLflow → `TraceEvent`. |
| `@assay/topology` | service-topology harnesses (multi-service + target env), Nomad/K8s. |
| `@assay/suite` | suites + version regression (`runSuite` / scorecard diff). |
| `@assay/db` | result store: `RunStore` (`InMemoryRunStore` / `PgRunStore`) + SQL migrations + migrator. |
| `@assay/registry` | harness version SSOT: `(id, version) → HarnessSpec`, immutable versions, file/GitOps loader + Postgres (`PgHarnessRegistry`). |
| `@assay/auth` | control-plane auth core: OIDC (Keycloak) + API keys → `Principal{workspace,roles}` + role-based authZ. |
| `apps/cli` | dev control plane: `assay run`, `assay worker`, `assay suite`. |
| `apps/api` | multi-tenant control-plane HTTP API (Fastify): owns auth (OIDC + API keys, role-gated, `/me`), async `POST /runs` + poll/webhook + result store, agent-facing **MCP server** (`/mcp`, OAuth via Keycloak + API keys). |
| `apps/web` | SaaS web (Next.js FSD, Tailwind/shadcn Toss-style): Keycloak login + per-tenant dashboard. |

## Two kinds of harness
- **Process harness** (Claude Code, Codex): one binary run in a sandbox.
- **Service-topology harness** (browser-use-langgraph): a deployed topology (agent / MCP / action-stream
  + Postgres/Redis/MinIO) that acts on a target env (browser + extension). Efficient: warm per-version
  services + shared ID-keyed stores + per-case browser. See `docs/service-harness.md`.

## Run
```bash
pnpm install && pnpm build
# local — uses THIS machine's claude subscription (no API key):
pnpm assay run --task "Create ok.txt with the text done" --test "grep -q done ok.txt"
# distributed (Nomad) and/or durable (Temporal): see docs/execution-backends.md + docs/orchestration.md
```

## Connect an agent (MCP)
The agent-facing surface is an OAuth-protected MCP server at `POST /mcp` — same tools as the HTTP API,
role-gated + workspace-scoped. Connect with **OAuth browser login (like Linear)** or a headless **API key**.
Endpoint: `http://<host>:8787/mcp` (set `<host>` to where `apps/api` runs; examples use the tailnet IP).

### Claude Code
```bash
# OAuth — "login like Linear": opens the browser, log in via Keycloak, done.
claude mcp add --transport http assay http://100.69.164.81:8787/mcp

# headless with an API key (CI / no browser):
claude mcp add --transport http assay http://100.69.164.81:8787/mcp \
  --header "Authorization: Bearer ak_..."
```

### Codex
Codex reaches a remote MCP via `mcp-remote` (runs the OAuth + PKCE flow). Add to `~/.codex/config.toml`:
```toml
[mcp_servers.assay]
command = "npx"
args = ["-y", "mcp-remote", "http://100.69.164.81:8787/mcp"]
# headless instead — drop the browser, use an API key:
# args = ["-y", "mcp-remote", "http://100.69.164.81:8787/mcp", "--header", "Authorization: Bearer ak_..."]
```

On first OAuth connect you log in to Keycloak and **approve a one-time consent** ("allow"), then the
loopback callback completes automatically — the whole DCR → PKCE auth-code → consent → token → `/mcp` flow is
verified end-to-end by `scripts/live/mcp-oauth.mjs`.

OAuth needs anonymous Dynamic Client Registration enabled once on Keycloak
(`deploy/keycloak/enable-mcp-dcr.sh` — loopback redirect URIs only). Get an API key from the web
(**Settings → API keys**) or `POST /keys`. Both credentials resolve to the same `Principal{workspace, roles}`.
See `docs/mcp.md`.

### When the browser doesn't open
"A browser window will open for authentication" means discovery + client registration already succeeded
(server side is fine) — only the local browser launch failed. Fixes:
```bash
claude mcp remove assay 2>/dev/null    # clear a half-finished add
rm -rf ~/.mcp-auth                      # clear stale mcp-remote OAuth cache

# A) open the printed URL yourself, or force the browser:
BROWSER=google-chrome claude mcp add --transport http assay http://100.69.164.81:8787/mcp

# B) mcp-remote prints the auth URL explicitly (same client Codex uses):
claude mcp add assay -- npx -y mcp-remote http://100.69.164.81:8787/mcp

# C) skip the browser entirely with an API key:
claude mcp add --transport http assay http://100.69.164.81:8787/mcp \
  --header "Authorization: Bearer ak_..."
```
A remote/SSH shell can't open a browser **and** receive the loopback callback — use the API key (C) there.

## Develop
```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Docs
- `docs/architecture/overview.md` — the architecture map
- `docs/service-harness.md` — multi-service topologies (Nomad/K8s, OTel/MLflow trace)
- `docs/execution-backends.md` — Backend vs Driver, multi-cluster routing
- `docs/orchestration.md` — Temporal durable control plane
- `docs/auth.md` — control-plane-owned auth core (OIDC/Keycloak + API keys, roles)
- `docs/sandbox-auth.md` — how `claude` authenticates across backends
- `docs/migration/` — DB migration discipline
- conventions: `CLAUDE.md` + `.claude/` (reinterpreted from `digo-api` / `digo-infra-dev`)

## Status
Permissive-licensed, self-hosted stack only. Validated **live**: local + real Claude Code (subscription);
durable Temporal end-to-end; Nomad batch dispatch (runner-agent image); service-topology on **both Nomad and
Kubernetes (kind)** (`NomadTopologyRuntime`/`K8sTopologyRuntime`: warm topology + per-case CDP browser +
per-tenant namespace isolation); the SaaS operational layer end-to-end on real Nomad — capacity-aware +
tenant-fair `Scheduler`, per-tenant trust-zone isolation + warm-pool separation, queue-depth autoscaling,
per-tenant secrets + budgets, the async `apps/api` HTTP surface (`POST /runs` → poll/webhook) with
**control-plane-owned auth** (OIDC via real Keycloak + API keys → `Principal{workspace,roles}`, role-based
authZ), tenant-owned harnesses + workspace-scoped reads, Postgres persistence (`PgRunStore` +
`PgHarnessRegistry` + migrations), the web as a **BFF token courier** (Keycloak login, token off the client),
and the agent-facing **MCP server** (`/mcp`, OAuth via Keycloak "login like Linear" + API keys, role-gated
tools — verified against real Keycloak). Still Phase-2 (need your infra/images): real browser+extension &
browser-use images, real OTel/MLflow span ingestion, ClickHouse analytics, the per-tenant dashboard.
