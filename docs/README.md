# Everdict docs

## Map & surfaces
- [architecture/overview.md](architecture/overview.md) — the architecture map (spine, eval loop, extension points)
- [architecture/collaboration.md](architecture/collaboration.md) — module collaboration diagrams (Mermaid): bird's-eye dependency/eval-loop/control-plane + one detailed diagram per package & app
- [api.md](api.md) — the control-plane HTTP API (`@everdict/api`): runs, scorecards, datasets, judges, runtimes, schedules, bundles, workspace integrations (GitHub App/Mattermost), runners — async `POST /runs` + poll/webhook
- [mcp.md](mcp.md) — the agent-facing **MCP server** (`apps/api` `/mcp`): OAuth-protected (Keycloak, "login like Linear MCP") + API keys, role-gated, **full BFF↔MCP parity**
- [web.md](web.md) — the SaaS web (`apps/web`, Next.js FSD, Linear-style): Keycloak login, `/{workspace}/…` dashboard, workspace settings, personal 계정 page
- [architecture/desktop-app.md](architecture/desktop-app.md) — the **desktop app** (`apps/desktop`, Electron): web-parity shell + resident self-hosted runner + one-click pairing + auto-update + 3-OS release CI

## Eval entities
- [registry.md](registry.md) — versioned SSOT (`@everdict/registry`): harnesses **· datasets · judges · runtimes**, `(tenant, id, version)`, immutable versions, `_shared` fallback
- [datasets.md](datasets.md) — harness-agnostic eval-case bundles (import, provenance, recipes)
- [judges.md](judges.md) — Agent Judges: `model` (LLM/VLM call) | `harness` (delegate an agent), applied per-trace on scorecards
- [runtimes.md](runtimes.md) — tenant-registered execution infra (docker/nomad/k8s/topology); "my machine" → self-hosted runner
- [scorecards.md](scorecards.md) — batch evals (dataset×harness → `Scorecard`+summary), baseline↔candidate diff, push/pull trace ingest, leaderboard
- [suites.md](suites.md) — suites & version regression (`everdict suite`, scorecard diff)
- [command-harness.md](command-harness.md) — declarative `command` harness: bring any CLI agent as a `HarnessSpec`, no code adapter
- [service-harness.md](service-harness.md) — service-topology harnesses (multi-service + browser/OS target env), Nomad/K8s, OTel/MLflow trace

## Execution & operations
- [execution-backends.md](execution-backends.md) — Backend (placement) vs Driver (in-sandbox), multi-cluster routing, capacity-aware + tenant-fair scheduling, trust zones, secrets/budgets, autoscaling
- [orchestration.md](orchestration.md) — durable control plane on Temporal (Direct/Temporal orchestrators + worker; powers scheduled evals)
- [auth.md](auth.md) — the control-plane-owned auth core (`@everdict/auth`): OIDC (Keycloak) + API keys → `Principal{workspace,roles}`, role-based authZ
- [tenancy.md](tenancy.md) — tenant access layer: workspace=tenant=trust-zone, tenant-owned entities, scoped reads
- [architecture/workspace-scoped-integrations.md](architecture/workspace-scoped-integrations.md) — workspace-owned **integrations**: GitHub App (org install → per-repo installation tokens: private-repo clone, CI setup-PR, runner registration) + Mattermost (completion/regression notify + slash-commands/buttons)
- [secrets.md](secrets.md) — workspace secret management: encrypted-at-rest model/provider keys, injected per-tenant into runs
- [usage-metering.md](usage-metering.md) — BYO model gateway + Everdict-owned budget: usage-proxy sidecar recovers per-run token usage → `budget.settle`
- [sandbox-auth.md](sandbox-auth.md) — how `claude` authenticates across backends (subscription / token injection)
- [dev.md](dev.md) — local development: persistent Keycloak + control-plane API + web hot-reload (`scripts/dev/up.sh`)
- [migration/README.md](migration/README.md) — DB migration discipline (expand→contract + preflight)

## Design SSOTs (`architecture/` — one doc per effort, decisions locked with the user)
- [desktop-app](architecture/desktop-app.md) · [self-hosted-runner](architecture/self-hosted-runner.md) · [self-hosted-service-runner](architecture/self-hosted-service-runner.md)
- [notifications](architecture/notifications.md) · [scheduled-evals](architecture/scheduled-evals.md) · [github-actions-trigger](architecture/github-actions-trigger.md) · [bundles](architecture/bundles.md)
- [leaderboard-model-dimension](architecture/leaderboard-model-dimension.md) · [run-as-primitive](architecture/run-as-primitive.md) · [execution-scoring-orchestration](architecture/execution-scoring-orchestration.md)
- [judge-placement-locality](architecture/judge-placement-locality.md) · [front-door-generalization](architecture/front-door-generalization.md) · [target-acquisition-generalization](architecture/target-acquisition-generalization.md)
- [completion-stream-callback](architecture/completion-stream-callback.md) · [portable-harness-runtime](architecture/portable-harness-runtime.md) · [harness-taxonomy](architecture/harness-taxonomy.md)

Conventions (single source of truth): [`../CLAUDE.md`](../CLAUDE.md) + `../.claude/` (rules + skills).
