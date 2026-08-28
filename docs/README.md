# Everdict docs

Every document in this tree is listed here. Conventions (single source of truth):
[`CLAUDE.md`](https://github.com/everdict/everdict/blob/main/CLAUDE.md) + `../.claude/` (rules + skills).

> **Two audiences, one tree.** [`guide/`](guide/README.md) is the product documentation — written for
> someone *using* Everdict, and the tree the public docs site publishes. Everything else here is
> maintainer-facing: reference pages, design records, runbooks. See
> [architecture/docs-site.md](architecture/docs-site.md) for how the two map onto the site.

## Guide — product documentation
- [guide/README.md](guide/README.md) — the section index
- **Get started** ([index](guide/start/README.md)) — [What is Everdict](guide/start/what-is-everdict.md) · [Quickstart](guide/start/quickstart.md) · [Your first scorecard](guide/start/first-scorecard.md) · [Bring your own agent](guide/start/bring-your-agent.md) · [Bundles](guide/start/bundles.md) · [Connect an agent](guide/start/connect-an-agent.md)
- **Core concepts** — [overview](guide/concepts/README.md) · [Run](guide/concepts/run.md) · [Harness](guide/concepts/harness.md) · [Dataset](guide/concepts/dataset.md) · [Grader & Judge](guide/concepts/grader-and-judge.md) · [Scorecard](guide/concepts/scorecard.md) · [Verdict](guide/concepts/verdict.md) · [Workspace](guide/concepts/workspace.md) · [Runtime](guide/concepts/runtime.md)
- **Your workspace** ([index](guide/workspace/README.md)) — [Workspace agents](guide/workspace/agents.md) · [What the agent knows](guide/workspace/agent-context.md) · [Filesystem](guide/workspace/filesystem.md) · [Environments](guide/workspace/environments.md) · [Secrets](guide/workspace/secrets.md) · [Image registry](guide/workspace/image-registry.md) · [Browser profiles](guide/workspace/browser-profiles.md)
- **Integrations** ([index](guide/integrations/README.md)) — [MCP](guide/integrations/mcp.md) · [Claude Code plugin](guide/integrations/claude-code-plugin.md) · [Running Codex](guide/integrations/codex.md) · [Desktop app](guide/integrations/desktop-app.md)
- **Operate** ([index](guide/operate/README.md)) — [Tracker](guide/operate/tracker.md) · [Schedules](guide/operate/schedules.md) · [Views](guide/operate/views.md) · [Durability](guide/operate/durability.md) · [Products & releases](guide/operate/product-timeline.md) · [Budgets](guide/operate/budgets.md) · [Notifications](guide/operate/notifications.md)
- **Self-hosting** — [overview](guide/self-host/overview.md)

## Start here (maintainers)
- [architecture/overview.md](architecture/overview.md) — the architecture map (spine, eval loop, extension points)
- [architecture/collaboration.md](architecture/collaboration.md) — module collaboration diagrams (Mermaid): bird's-eye dependency/eval-loop/control-plane + one detailed diagram per package & app
- [architecture/execution-scoring-orchestration.md](architecture/execution-scoring-orchestration.md) — the three concerns, and why they stay apart
- [dev.md](dev.md) — local development: persistent Keycloak + control-plane API + web hot-reload (`scripts/dev/up.sh`)

## Surfaces
- [api.md](api.md) — the control-plane HTTP API (`apps/api`): runs, scorecards, datasets, judges, runtimes, schedules, bundles, workspace integrations, runners — async `POST /runs` + poll/webhook
- [mcp.md](mcp.md) — the agent-facing **MCP server** (`/mcp`): OAuth-protected (Keycloak) + API keys, role-gated, **full BFF↔MCP parity**
- [web.md](web.md) — the SaaS web (`apps/web`, Next.js FSD, Linear-style): Keycloak login, `/{workspace}/…` dashboard, workspace settings, personal account page
- [architecture/desktop-app.md](architecture/desktop-app.md) — the desktop app (`apps/desktop`, Electron): web-parity shell + resident self-hosted runner + one-click pairing + auto-update + 3-OS release CI
- [architecture/one-call-sdk.md](architecture/one-call-sdk.md) — reproduce env + N trials + score → verdict in one `await`
- [everdict-otel.md](everdict-otel.md) — `@everdict/otel`: sending traces **to** Everdict (migration recipes)

## Eval entities
- [registry.md](registry.md) — versioned SSOT (`@everdict/registry`): harnesses · datasets · judges · runtimes, `(tenant, id, version)`, immutable versions, `_shared` fallback
- [datasets.md](datasets.md) — harness-agnostic eval-case bundles (import, provenance, recipes)
- [judges.md](judges.md) — Agent Judges: `model` (LLM/VLM call) | `harness` (delegate an agent), applied per-trace on scorecards
- [models.md](models.md) — workspace-registered LLM models (provider · model · baseUrl · `apiKeySecret`), referenced by id from a judge/harness
- [runtimes.md](runtimes.md) — tenant-registered execution infra (`local` | `nomad` | `k8s`); "my machine" → self-hosted runner
- [scorecards.md](scorecards.md) — batch evals (dataset×harness → `Scorecard`+summary), baseline↔candidate diff, push/pull trace ingest, leaderboard
- [suites.md](suites.md) — suites & version regression (`everdict suite`, scorecard diff)
- [command-harness.md](command-harness.md) — declarative `command` harness: bring any CLI agent as a `HarnessSpec`, no code adapter
- [service-harness.md](service-harness.md) — service-topology harnesses (multi-service + browser/OS target env), Nomad/K8s, OTel/MLflow trace
- [architecture/harness-taxonomy.md](architecture/harness-taxonomy.md) — Template (category) + Instance, pins and resolution
- [architecture/harness-playground.md](architecture/harness-playground.md) — interactive test cases against a live harness session
- [architecture/eval-domain-model.md](architecture/eval-domain-model.md) — the Dataset / Rubric / Grader split
- [architecture/standard-task-formats.md](architecture/standard-task-formats.md) — bring an existing agent benchmark, run it managed
- [architecture/bundles.md](architecture/bundles.md) — one-shot self-serve registration (harness + benchmark + runtime as a unit)
- [architecture/managed-case-image.md](architecture/managed-case-image.md) — the `case.image` agent-bootstrap contract

## Scoring & verdicts
- [trust-certification.md](trust-certification.md) — the nightly invariant suite: what "a defensible verdict" is mechanically pinned to
- [architecture/trial-based-verdict.md](architecture/trial-based-verdict.md) — pass@k, flakiness & statistical regression
- [architecture/judge-input-contract.md](architecture/judge-input-contract.md) — declare, preview, dry-run
- [architecture/judge-placement-locality.md](architecture/judge-placement-locality.md) — judge runtime selection + store-locality placement
- [architecture/scoring-plane-revisions.md](architecture/scoring-plane-revisions.md) — the scoring plane as revisions (MVCC)
- [architecture/scorecard-analysis-views.md](architecture/scorecard-analysis-views.md) — scorecard analysis + saved Views (SSOT)
- [architecture/leaderboard-model-dimension.md](architecture/leaderboard-model-dimension.md) — model as a first-class dimension (harness × model × benchmark)
- [architecture/streaming-case-pipeline.md](architecture/streaming-case-pipeline.md) — kill the batch barriers, release compute early

## Execution & placement
- [execution-backends.md](execution-backends.md) — Backend (placement) vs Driver (in-sandbox), multi-cluster routing, capacity-aware + tenant-fair scheduling, trust zones, secrets/budgets, autoscaling
- [orchestration.md](orchestration.md) — durable control plane on Temporal (Direct/Temporal orchestrators + worker; powers scheduled evals)
- [architecture/execution-model.md](architecture/execution-model.md) — Run as the platform's universal execution record
- [architecture/run-as-primitive.md](architecture/run-as-primitive.md) — scorecard = orchestration over runs
- [architecture/execution-master-plan.md](architecture/execution-master-plan.md) — **PLAN OF RECORD**: the five designs sequenced into waves
- [architecture/scheduled-evals.md](architecture/scheduled-evals.md) — run a scorecard on a cron schedule (regression monitoring)
- [architecture/batch-resilience.md](architecture/batch-resilience.md) — transient retry · restart resume · retry-failed
- [architecture/temporal-batch-orchestration.md](architecture/temporal-batch-orchestration.md) — SHIPPED, live-verified against a real Temporal
- [architecture/work-queue.md](architecture/work-queue.md) — workload visibility (running/queued/next-scheduled per runtime lane)
- [architecture/multi-replica.md](architecture/multi-replica.md) — running more than one control-plane replica
- [architecture/completion-stream-callback.md](architecture/completion-stream-callback.md) — front-door completion: stream & callback modes
- [architecture/front-door-generalization.md](architecture/front-door-generalization.md) — absorbing the control plane into the topology front door
- [architecture/target-acquisition-generalization.md](architecture/target-acquisition-generalization.md) — the target axis
- [architecture/heterogeneous-topology-placement.md](architecture/heterogeneous-topology-placement.md) — infra-agnostic, capability-driven placement
- [architecture/nomad-colocated-topology.md](architecture/nomad-colocated-topology.md) — Nomad co-located service topology
- [architecture/topology-portability.md](architecture/topology-portability.md) — one `HarnessSpec`, identical semantics on every runtime
- [architecture/portable-harness-runtime.md](architecture/portable-harness-runtime.md) — one definition, runs whole anywhere (managed **or** the user's laptop)
- [architecture/suna-harness-gaps.md](architecture/suna-harness-gaps.md) — Suna (Kortix) as a harness: the mapping and the gaps it exposes

## Self-hosted runners
- [architecture/self-hosted-runner.md](architecture/self-hosted-runner.md) — run a workspace's harness/dataset on *your own* machine
- [architecture/self-hosted-runtime-and-runners.md](architecture/self-hosted-runtime-and-runners.md) — a pool you target, workers that drain it
- [architecture/self-hosted-service-runner.md](architecture/self-hosted-service-runner.md) — drive *service* (topology) harnesses on your own machine
- [architecture/runner-distribution.md](architecture/runner-distribution.md) — a one-liner install for a headless machine
- [architecture/runtime-inspection.md](architecture/runtime-inspection.md) — a live cluster read model
- [runbooks/github-self-hosted-runner.md](runbooks/github-self-hosted-runner.md) — runbook: GitHub self-hosted runner co-registration

## Environments & images
- [architecture/agent-worlds.md](architecture/agent-worlds.md) — persistent environments over ephemeral sandboxes
- [architecture/browser-profiles.md](architecture/browser-profiles.md) — a real interactive remote browser, cookies reused in eval
- [architecture/environment-image-store.md](architecture/environment-image-store.md) — managed eval-environment images as store assets
- [architecture/managed-image-store.md](architecture/managed-image-store.md) — the managed image store
- [architecture/workspace-image-registry.md](architecture/workspace-image-registry.md) — classify + publish harness images (BYO registry)
- [architecture/secret-free-execution-envelope.md](architecture/secret-free-execution-envelope.md) — taking the job payload out of the container's environment (designed, not implemented)
- [sandbox-auth.md](sandbox-auth.md) — how `claude` authenticates across backends (subscription / token injection)

## Observability
- [architecture/native-observability.md](architecture/native-observability.md) — Everdict as the trace platform (OTel-first)
- [architecture/otel-trace-model.md](architecture/otel-trace-model.md) — spans are the record; `TraceEvent` is a projection
- [architecture/long-horizon-trace-reads.md](architecture/long-horizon-trace-reads.md) — the event is the unit; why a long run's trace exhausted the heap
- [architecture/live-observability.md](architecture/live-observability.md) — watch a run while it runs
- [architecture/trace-sink.md](architecture/trace-sink.md) — export judged results to the team's observability platform
- [architecture/replay.md](architecture/replay.md) — record a run so the analysis phase can re-watch it
- [architecture/notifications.md](architecture/notifications.md) — job completion via web inbox + desktop native
- [architecture/workspace-pulse.md](architecture/workspace-pulse.md) — the home screen's one read

## Work, knowledge & the product axis
- [tracker.md](tracker.md) — the eval tracker: Initiative ⊃ Project ⊃ Issue (the "why we evaluate" layer)
- [architecture/product-timeline.md](architecture/product-timeline.md) — Product ⊃ Release over an imported version ledger (the "what we ship" axis)
- [architecture/workspace-filesystem.md](architecture/workspace-filesystem.md) — one isolated file tree per workspace, attributed revisions, three-way merge
- [architecture/knowledge-graph.md](architecture/knowledge-graph.md) — the workspace knowledge graph
- [architecture/evolution-lineage.md](architecture/evolution-lineage.md) — evolution lineage: ancestry recorded at the write, events on the outbox, the campaign as a settlement
- [architecture/capability-store.md](architecture/capability-store.md) — the capability store (SSOT)
- [architecture/analysis-studio.md](architecture/analysis-studio.md) — natural-language analysis, artifacts, scheduled reports over Views
- [architecture/event-plumbing.md](architecture/event-plumbing.md) — the platform's nervous system: facts, one log + N cursor consumers, subscriptions
- [architecture/ownership-protocol.md](architecture/ownership-protocol.md) — the ownership protocol
- [architecture/dependency-store-roles.md](architecture/dependency-store-roles.md) — plumbing vs data, and data-as-condition

## Agents
- [architecture/agent-automation.md](architecture/agent-automation.md) — platform-triggered agents, fleet observability, the crafting studio
- [architecture/agent-conversations.md](architecture/agent-conversations.md) — a conversational, multi-turn agent over the eval control plane
- [architecture/agent-teams.md](architecture/agent-teams.md) — message-based collaboration + proactive agents
- [architecture/agent-execution-auth.md](architecture/agent-execution-auth.md) — a credential for request-less agent turns

## Tenancy, auth & integrations
- [auth.md](auth.md) — the control-plane-owned auth core (`@everdict/auth`): OIDC (Keycloak) + API keys → `Principal{workspace,roles}`, role-based authZ
- [tenancy.md](tenancy.md) — tenant access layer: workspace = tenant = trust zone, tenant-owned entities, scoped reads
- [secrets.md](secrets.md) — workspace secret management: encrypted-at-rest model/provider keys, injected per-tenant into runs
- [architecture/workspace-scoped-integrations.md](architecture/workspace-scoped-integrations.md) — workspace-owned GitHub App + Mattermost (replacing personal Connected accounts)
- [architecture/github-actions-trigger.md](architecture/github-actions-trigger.md) — CI-fired evals + zero-input repo↔service integration
- [runbooks/corporate-proxy.md](runbooks/corporate-proxy.md) — runbook: deploying behind a corporate proxy

## Billing & metrics
- [usage-metering.md](usage-metering.md) — BYO model gateway + Everdict-owned budget: usage-proxy sidecar recovers per-run token usage → `budget.settle`
- [architecture/usage-metering.md](architecture/usage-metering.md) — the billing surface (meter-only, durable)
- [architecture/metrics-commercialization.md](architecture/metrics-commercialization.md) — two products, three bundles, one closed scrape

## Database migrations
- [migration/README.md](migration/README.md) — migration discipline (expand → deploy → contract, preflight checks)
- Per-migration preflight records: [0001_create_runs](migration/preflight/0001_create_runs.md) · [0002_create_harnesses](migration/preflight/0002_create_harnesses.md) · [0003_create_tenant_keys](migration/preflight/0003_create_tenant_keys.md) · [0004_harness_tenant](migration/preflight/0004_harness_tenant.md) · [0023_connections_owner](migration/preflight/0023_connections_owner.md) *(superseded)* · [0200_trajectory_events](migration/preflight/0200_trajectory_events.md)

## The public docs site
- [architecture/docs-site.md](architecture/docs-site.md) — information architecture for the Docusaurus site published from this tree
- [architecture/docs-quality-rubric.md](architecture/docs-quality-rubric.md) — the scoring instrument used to close the gap to Mastra

## Internals — historical design records
> Written during the re-architecture review and **not maintained since**. The umbrella migration
> SHIPPED on 2026-07-10, so the `packages/{core,suite,run-case,billing}` and `apps/api/src/core/**`
> paths they cite name the pre-migration layout. Read them for the reasoning, not the addresses.

- [architecture/rearchitecture/00-target-architecture.md](architecture/rearchitecture/00-target-architecture.md) — the target architecture (SHIPPED)
- Per-domain collaboration models: [auth](architecture/rearchitecture/domains/auth.md) · [billing](architecture/rearchitecture/domains/billing.md) · [comment](architecture/rearchitecture/domains/comment.md) · [dataset](architecture/rearchitecture/domains/dataset.md) · [failure](architecture/rearchitecture/domains/failure.md) · [harness](architecture/rearchitecture/domains/harness.md) · [integrations](architecture/rearchitecture/domains/integrations.md) · [judge](architecture/rearchitecture/domains/judge.md) · [member](architecture/rearchitecture/domains/member.md) · [notification](architecture/rearchitecture/domains/notification.md) · [ops](architecture/rearchitecture/domains/ops.md) · [run](architecture/rearchitecture/domains/run.md) · [runner](architecture/rearchitecture/domains/runner.md) · [runtime](architecture/rearchitecture/domains/runtime.md) · [schedule](architecture/rearchitecture/domains/schedule.md) · [scorecard](architecture/rearchitecture/domains/scorecard.md) · [secret-key](architecture/rearchitecture/domains/secret-key.md) · [trace](architecture/rearchitecture/domains/trace.md) · [view](architecture/rearchitecture/domains/view.md)
- [architecture/api-route-modularization.md](architecture/api-route-modularization.md) — splitting the monolithic `server.ts` into resource route modules (SHIPPED)
- [architecture/rich-domain-core.md](architecture/rich-domain-core.md) — the domain expresses itself
