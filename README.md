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
| `@assay/backends` | placement: `Backend` (Local, Nomad) + `Router` (static) / `Scheduler` (capacity-aware) / `BackendRegistry`. |
| `@assay/orchestrator` | durable control plane on Temporal (Direct / Temporal + worker). |
| `@assay/trace` | pull a harness trace from OTel/MLflow → `TraceEvent`. |
| `@assay/topology` | service-topology harnesses (multi-service + target env), Nomad/K8s. |
| `@assay/suite` | suites + version regression (`runSuite` / scorecard diff). |
| `@assay/db` | result store: `RunStore` (`InMemoryRunStore` / `PgRunStore`) + SQL migrations + migrator. |
| `@assay/registry` | harness version SSOT: `(id, version) → HarnessSpec`, immutable versions, file/GitOps loader. |
| `apps/cli` | dev control plane: `assay run`, `assay worker`, `assay suite`. |
| `apps/api` | multi-tenant control-plane HTTP API (Fastify): async `POST /runs` + poll/webhook + result store. |

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

## Develop
```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Docs
- `docs/architecture/overview.md` — the architecture map
- `docs/service-harness.md` — multi-service topologies (Nomad/K8s, OTel/MLflow trace)
- `docs/execution-backends.md` — Backend vs Driver, multi-cluster routing
- `docs/orchestration.md` — Temporal durable control plane
- `docs/sandbox-auth.md` — how `claude` authenticates across backends
- `docs/migration/` — DB migration discipline
- conventions: `CLAUDE.md` + `.claude/` (reinterpreted from `digo-api` / `digo-infra-dev`)

## Status
Permissive-licensed, self-hosted stack only. Validated **live**: local + real Claude Code (subscription);
durable Temporal end-to-end; Nomad batch dispatch (runner-agent image); service-topology on **both Nomad and
Kubernetes (kind)** (`NomadTopologyRuntime`/`K8sTopologyRuntime`: warm topology + per-case CDP browser +
per-tenant namespace isolation); the SaaS operational layer end-to-end on real Nomad — capacity-aware +
tenant-fair `Scheduler`, per-tenant trust-zone isolation + warm-pool separation, queue-depth autoscaling,
per-tenant secrets + budgets, the async `apps/api` HTTP surface (`POST /runs` → poll/webhook), and a Postgres
result store (`PgRunStore` + migrations). Still Phase-2 (need your infra/images): real browser+extension &
browser-use images, real OTel/MLflow span ingestion, ClickHouse analytics store.
