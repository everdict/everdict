---
kind: wiki
title: "Everdict docs"
status: current
updated: 2026-09-15
---
# Everdict docs

Every document in this tree is listed here. Conventions (single source of truth):
[`CLAUDE.md`](https://github.com/everdict/everdict/blob/main/CLAUDE.md) + `../.claude/` (rules + skills).

> **Two audiences, one tree.** [`guide/`](guide/README.md) is the product documentation — written for
> someone *using* Everdict. Everything else here is maintainer-facing: reference pages, design records,
> runbooks. How the work on this repository is planned, reviewed and remembered is not documented here — it
> accumulates in Everdict ([architecture/sdlc-out-of-the-repository.md](architecture/sdlc-out-of-the-repository.md)). Every
> document declares which of four kinds it is — see [architecture/document-kinds.md](architecture/document-kinds.md). Nothing is published outside this
> repository: [architecture/docs-site-removal.md](architecture/docs-site-removal.md).

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
- [architecture/evolution-program-gap-map.md](architecture/evolution-program-gap-map.md) — the four-pillar program (define any harness · one identity + seeds on the version · honest benchmarks + exact evidence · routed evolution), what holds, and the spec that closes each gap
- [dev.md](dev.md) — local development: Postgres + Keycloak + control-plane API + web hot-reload (`scripts/dev/up.sh`)

## Surfaces
- [api.md](api.md) — the control-plane HTTP API (`apps/api`): what the generated `/docs` reference cannot say — async run lifecycle + webhook delivery, error envelope, run audience, result/trajectory stores
- [mcp.md](mcp.md) — the agent-facing **MCP server** (`/mcp`): sessions, OAuth (Keycloak) + key/token credentials, error format — the tool catalog is `tools/list`
- [web.md](web.md) — the SaaS web (`apps/web`, Next.js FSD): Keycloak login, `/{workspace}/…` routes, settings sections (account · workspace · agent · browser)
- [architecture/desktop-app.md](architecture/desktop-app.md) — the desktop app (`apps/desktop`, Electron): web-parity shell + resident self-hosted runner + pairing from the Runtimes page + auto-update
- [architecture/one-call-sdk.md](architecture/one-call-sdk.md) — reproduce env + N trials + score → verdict in one `await`
- [everdict-otel.md](everdict-otel.md) — `@everdict/otel`: sending traces **to** Everdict (migration recipes)

## Eval entities
- [registry.md](registry.md) — versioned registries (`@everdict/registry`): harness templates + instances · datasets · judges · rubrics · models · runtimes · environments, `(tenant, id, version)`, immutable versions, `_shared` fallback
- [datasets.md](datasets.md) — harness-agnostic eval-case bundles (import wizard, catalog scoring semantics, provenance)
- [judges.md](judges.md) — Agent Judges: `code` (sandboxed user code — the registration surface) + legacy `model`/`harness`, applied per-trace on scorecards
- [models.md](models.md) — workspace-registered LLM models (provider · model · baseUrl · `apiKeySecret`), referenced by id from a judge/harness
- [runtimes.md](runtimes.md) — tenant-registered execution infra (`local` | `nomad` | `k8s`); "my machine" → self-hosted runner
- [scorecards.md](scorecards.md) — batch evals (dataset×harness → `Scorecard`+summary), baseline↔candidate diff, push/pull trace ingest, leaderboard
- [architecture/in-place-case-retry-spec.md](architecture/in-place-case-retry-spec.md) — retrying a case inside its own scorecard: the attempt ledger, the execution revision, and why the ordinal is not on `CaseResult`
- [architecture/web-runtime-gap-census-spec.md](architecture/web-runtime-gap-census-spec.md) — a counted census of what the control plane supported and `apps/web` could not reach (2026-09-04), the slices that closed it, and the `web-reach` gate that keeps it closed
- [suites.md](suites.md) — suites & version regression (`everdict suite`, scorecard diff)
- [command-harness.md](command-harness.md) — declarative `command` harness: bring any CLI agent as a `HarnessSpec`, no code adapter
- [service-harness.md](service-harness.md) — service-topology harnesses (browser/api/os target): spec, front door, Docker/Nomad/K8s runtimes, store/network isolation, trace sources
- [architecture/harness-taxonomy.md](architecture/harness-taxonomy.md) — Template (category) + Instance, pins and resolution
- [architecture/world-and-engagement-model.md](architecture/world-and-engagement-model.md) — design: the world a case acts on (delivery · lifecycle) and how the actor meets the question (engagement)
- [architecture/harness-definability-spec.md](architecture/harness-definability-spec.md) — spec: a client is a target of any kind, the environment is a registered entity, first-party coding-agent recipes, the case reaches the harness
- [architecture/harness-identity-and-seeds-spec.md](architecture/harness-identity-and-seeds-spec.md) — spec: forks recorded at register, skill/wiki seeds on the harness version (inside the digest), lineage in one read, a seeded finding is a leak
- [architecture/harness-playground.md](architecture/harness-playground.md) — interactive test cases against a live harness session
- [architecture/eval-domain-model.md](architecture/eval-domain-model.md) — the Dataset / Rubric / Grader split
- [architecture/standard-task-formats.md](architecture/standard-task-formats.md) — bring an existing agent benchmark, run it managed
- [architecture/bundles.md](architecture/bundles.md) — one-shot self-serve registration (harness + benchmark + runtime as a unit)
- [architecture/managed-case-image.md](architecture/managed-case-image.md) — the `case.image` agent-bootstrap contract

## Scoring & verdicts
- [trust-certification.md](trust-certification.md) — the invariant suite (`pnpm trust-fast`/`trust-full`, run by hand): what "a defensible verdict" is mechanically pinned to
- [architecture/trial-based-verdict.md](architecture/trial-based-verdict.md) — pass@k, flakiness & statistical regression
- [architecture/benchmark-evidence-spec.md](architecture/benchmark-evidence-spec.md) — spec: finish the benchmark on-ramps, a judge-authored agent diagnosis, the round's evidence as an immutable platform-derived record, export only what is citable
- [architecture/judge-input-contract.md](architecture/judge-input-contract.md) — declare, preview, dry-run
- [architecture/judge-placement-locality.md](architecture/judge-placement-locality.md) — judge runtime selection, co-location with the producing run, and pluggable observation delivery (reference/sentinel/egress/trace)
- [architecture/scoring-plane-revisions.md](architecture/scoring-plane-revisions.md) — the scoring plane as revisions (MVCC)
- [architecture/scorecard-analysis-views.md](architecture/scorecard-analysis-views.md) — scorecard analysis + saved Views (SSOT)
- [architecture/leaderboard-model-dimension.md](architecture/leaderboard-model-dimension.md) — model as a first-class dimension (harness × model × benchmark)
- [architecture/streaming-case-pipeline.md](architecture/streaming-case-pipeline.md) — kill the batch barriers, release compute early

## Execution & placement
- [execution-backends.md](execution-backends.md) — Backend (placement) vs Driver (in-sandbox), multi-cluster routing, capacity-aware + tenant-fair scheduling, trust zones, secrets/budgets, autoscaling
- [orchestration.md](orchestration.md) — durable control plane on Temporal: the workflows (batch, score, approval, reaper, reaction, schedule), the driver ops surface, and what is refused
- [architecture/execution-model.md](architecture/execution-model.md) — Run as the platform's universal execution record
- [architecture/scheduled-evals.md](architecture/scheduled-evals.md) — run a scorecard, trace evaluation or view report on a cron schedule (Temporal Schedules)
- [architecture/batch-resilience.md](architecture/batch-resilience.md) — transient retry · restart resume · retry-failed
- [architecture/temporal-batch-orchestration.md](architecture/temporal-batch-orchestration.md) — a scorecard batch as one durable Temporal workflow (continue-as-new, workflow-owned recovery)
- [architecture/work-queue.md](architecture/work-queue.md) — workload visibility (running/queued/next-scheduled per runtime lane)
- [architecture/multi-replica.md](architecture/multi-replica.md) — running more than one control-plane replica
- [architecture/completion-stream-callback.md](architecture/completion-stream-callback.md) — front-door completion: sync, poll, stream, callback and trace modes
- [architecture/front-door-generalization.md](architecture/front-door-generalization.md) — the declarative front door: request, completion, correlation, target gate, image pins
- [architecture/target-acquisition-generalization.md](architecture/target-acquisition-generalization.md) — the target axis
- [architecture/heterogeneous-topology-placement.md](architecture/heterogeneous-topology-placement.md) — infra-agnostic, capability-driven placement
- [architecture/nomad-colocated-topology.md](architecture/nomad-colocated-topology.md) — Nomad co-located service topology
- [architecture/topology-portability.md](architecture/topology-portability.md) — one `HarnessSpec`, identical semantics on every runtime
- [architecture/portable-harness-runtime.md](architecture/portable-harness-runtime.md) — one definition, runs whole anywhere (managed **or** the user's laptop)
- [architecture/suna-harness-gaps.md](architecture/suna-harness-gaps.md) — Suna (Kortix) as a harness: the mapping and the gaps it exposed

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
- [architecture/secret-free-execution-envelope.md](architecture/secret-free-execution-envelope.md) — taking the job payload out of the container's environment: a file the runner unlinks, not an env var
- [sandbox-auth.md](sandbox-auth.md) — how `claude` authenticates across backends (subscription / token injection)

## Observability
- [architecture/native-observability.md](architecture/native-observability.md) — Everdict as the trace platform (OTel-first)
- [architecture/otel-trace-model.md](architecture/otel-trace-model.md) — spans are the record; `TraceEvent` is a projection
- [architecture/long-horizon-trace-reads.md](architecture/long-horizon-trace-reads.md) — the event is the unit; why a long run's trace exhausted the heap
- [architecture/control-plane-read-budget.md](architecture/control-plane-read-budget.md) — no read grows with the workspace; the pool/statement ceilings and where a screen's filter belongs
- [architecture/live-observability.md](architecture/live-observability.md) — watch a run while it runs
- [architecture/trace-sink.md](architecture/trace-sink.md) — export judged results to the team's observability platform
- [architecture/replay.md](architecture/replay.md) — record a run so the analysis phase can re-watch it
- [architecture/notifications.md](architecture/notifications.md) — job completion via web inbox + desktop native
- [architecture/workspace-pulse.md](architecture/workspace-pulse.md) — the workspace's one status read (API/MCP; no longer the home screen)

## Work, knowledge & the product axis
- [architecture/development-system-of-record.md](architecture/development-system-of-record.md) — *(proposed)* Everdict as the development system of record: a methodology seed, the work chain, and lineage and direction per service — code repositories keep only their product
- [tracker.md](tracker.md) — the eval tracker: Initiative ⊃ Project ⊃ Issue (the "why we evaluate" layer)
- [architecture/product-timeline.md](architecture/product-timeline.md) — Product ⊃ Release over an imported version ledger (the "what we ship" axis)
- [architecture/workspace-filesystem.md](architecture/workspace-filesystem.md) — one isolated file tree per workspace, attributed revisions, three-way merge
- [architecture/workspace-knowledge.md](architecture/workspace-knowledge.md) — workspace knowledge: knowledge entries with time-axis pins, coverage and anchor relation, task-context assembly, thread extraction, HTTP/MCP (and the knowledge graph that was removed)
- [architecture/evolution-lineage.md](architecture/evolution-lineage.md) — evolution lineage: ancestry recorded at the write, events on the outbox, the campaign as a settlement
- [architecture/evolution-review-follow-up.md](architecture/evolution-review-follow-up.md) — evaluated identities, family attempts, adoption claims and scoped delegate evidence
- [architecture/parallel-evolution.md](architecture/parallel-evolution.md) — campaigns in parallel form a tree: what the shared held-out family costs, why bytes merge and evidence does not, and the one place the schema is a tree where a merge needs a DAG
- [architecture/evolution-literature-review.md](architecture/evolution-literature-review.md) — WikiSkill, all 46 direct references, and 13 complementary papers: mechanisms, limitations, and insights for Everdict
- [architecture/evolution-papers/README.md](architecture/evolution-papers/README.md) — detailed explanations of every paper: principles, experiments, results, related work, limitations, and Everdict applications
<!-- evolution-paper-notes:start -->
- [Evolution S00: WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution](architecture/evolution-papers/S00.md)
- [Evolution R01: GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](architecture/evolution-papers/R01.md)
- [Evolution R02: EvoSkill: Automated Skill Discovery for Multi-Agent Systems](architecture/evolution-papers/R02.md)
- [Evolution R03: The complete guide to building skills for Claude](architecture/evolution-papers/R03.md)
- [Evolution R04: SkillCraft: Can LLM Agents Learn to Use Tools Skillfully?](architecture/evolution-papers/R04.md)
- [Evolution R05: HarnessX: A Composable, Adaptive, and Evolvable Agent Harness Foundry](architecture/evolution-papers/R05.md)
- [Evolution R06: SkillRet: A Large-Scale Benchmark for Skill Retrieval in LLM Agents](architecture/evolution-papers/R06.md)
- [Evolution R07: Gemma 4 Technical Report](architecture/evolution-papers/R07.md)
- [Evolution R08: Gemini 3.5 Flash model card](architecture/evolution-papers/R08.md)
- [Evolution R09: LiveMathematicianBench: A Live Benchmark for Mathematician-Level Reasoning with Proof Sketches](architecture/evolution-papers/R09.md)
- [Evolution R10: AA-Omniscience: Evaluating Cross-Domain Knowledge Reliability in Large Language Models](architecture/evolution-papers/R10.md)
- [Evolution R11: SoK: Agentic Skills -- Beyond Tool Use in LLM Agents](architecture/evolution-papers/R11.md)
- [Evolution R12: LLM Wiki](architecture/evolution-papers/R12.md)
- [Evolution R13: Efficient Memory Management for Large Language Model Serving with PagedAttention](architecture/evolution-papers/R13.md)
- [Evolution R14: Meta-Harness: End-to-End Optimization of Model Harnesses](architecture/evolution-papers/R14.md)
- [Evolution R15: SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks](architecture/evolution-papers/R15.md)
- [Evolution R16: SkillNet: Create, Evaluate, and Connect AI Skills](architecture/evolution-papers/R16.md)
- [Evolution R17: Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses](architecture/evolution-papers/R17.md)
- [Evolution R18: How Well Do Agentic Skills Work in the Wild: Benchmarking LLM Skill Usage in Realistic Settings](architecture/evolution-papers/R18.md)
- [Evolution R19: AutoHarness: improving LLM agents by automatically synthesizing a code harness](architecture/evolution-papers/R19.md)
- [Evolution R20: SKILL0: In-Context Agentic Reinforcement Learning for Skill Internalization](architecture/evolution-papers/R20.md)
- [Evolution R21: SpreadsheetBench: Towards Challenging Real World Spreadsheet Manipulation](architecture/evolution-papers/R21.md)
- [Evolution R22: Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces](architecture/evolution-papers/R22.md)
- [Evolution R23: Trace2Skill: Distill Trajectory-Local Lessons into Transferable Agent Skills](architecture/evolution-papers/R23.md)
- [Evolution R24: SkillOS: Learning Skill Curation for Self-Evolving Agents](architecture/evolution-papers/R24.md)
- [Evolution R25: GDPval: Evaluating AI Model Performance on Real-World Economically Valuable Tasks](architecture/evolution-papers/R25.md)
- [Evolution R26: SealQA: Raising the Bar for Reasoning in Search-Augmented Language Models](architecture/evolution-papers/R26.md)
- [Evolution R27: A benchmark of expert-level academic questions to assess AI capabilities (Humanity’s Last Exam)](architecture/evolution-papers/R27.md)
- [Evolution R28: Qwen3.5: Towards native multimodal agents](architecture/evolution-papers/R28.md)
- [Evolution R29: Qwen3.6-27B](architecture/evolution-papers/R29.md)
- [Evolution R30: Skill1: Unified Evolution of Skill-Augmented Agents via Reinforcement Learning](architecture/evolution-papers/R30.md)
- [Evolution R31: ALFWorld: Aligning Text and Embodied Environments for Interactive Learning](architecture/evolution-papers/R31.md)
- [Evolution R32: OfficeQA](architecture/evolution-papers/R32.md)
- [Evolution R33: Skill Retrieval Augmentation for Agentic AI](architecture/evolution-papers/R33.md)
- [Evolution R34: SkillGrad: Optimizing Agent Skills Like Gradient Descent](architecture/evolution-papers/R34.md)
- [Evolution R35: SkillRL: Evolving Agents via Recursive Skill-Augmented Reinforcement Learning](architecture/evolution-papers/R35.md)
- [Evolution R36: MetaClaw: Just Talk -- An Agent That Meta-Learns and Evolves in the Wild](architecture/evolution-papers/R36.md)
- [Evolution R37: Agent Skills for Large Language Models: Architecture, Acquisition, Security, and the Path Forward](architecture/evolution-papers/R37.md)
- [Evolution R38: SkillOpt: Executive Strategy for Self-Evolving Agent Skills](architecture/evolution-papers/R38.md)
- [Evolution R39: ReAct: Synergizing Reasoning and Acting in Language Models](architecture/evolution-papers/R39.md)
- [Evolution R40: Meta Context Engineering via Agentic Skill Evolution](architecture/evolution-papers/R40.md)
- [Evolution R41: Optimizing generative AI by backpropagating language model feedback (TextGrad)](architecture/evolution-papers/R41.md)
- [Evolution R42: Equipping agents for the real world with Agent Skills](architecture/evolution-papers/R42.md)
- [Evolution R43: Self-Harness: Harnesses That Improve Themselves](architecture/evolution-papers/R43.md)
- [Evolution R44: CoEvoSkills: Self-Evolving Agent Skills via Co-Evolutionary Verification](architecture/evolution-papers/R44.md)
- [Evolution R45: SkillRouter: Skill Routing for LLM Agents at Scale](architecture/evolution-papers/R45.md)
- [Evolution R46: Memento-Skills: Let Agents Design Agents](architecture/evolution-papers/R46.md)
- [Evolution E01: Reflexion: Language Agents with Verbal Reinforcement Learning](architecture/evolution-papers/E01.md)
- [Evolution E02: Self-Refine: Iterative Refinement with Self-Feedback](architecture/evolution-papers/E02.md)
- [Evolution E03: Voyager: An Open-Ended Embodied Agent with Large Language Models](architecture/evolution-papers/E03.md)
- [Evolution E04: Automated Design of Agentic Systems](architecture/evolution-papers/E04.md)
- [Evolution E05: AFlow: Automating Agentic Workflow Generation](architecture/evolution-papers/E05.md)
- [Evolution E06: Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents](architecture/evolution-papers/E06.md)
- [Evolution E07: AlphaEvolve: A coding agent for scientific and algorithmic discovery](architecture/evolution-papers/E07.md)
- [Evolution E08: Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models](architecture/evolution-papers/E08.md)
- [Evolution E09: ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory](architecture/evolution-papers/E09.md)
- [Evolution E10: Illuminating search spaces by mapping elites](architecture/evolution-papers/E10.md)
- [Evolution E11: Paired Open-Ended Trailblazer (POET): Endlessly Generating Increasingly Complex and Diverse Learning Environments and Their Solutions](architecture/evolution-papers/E11.md)
- [Evolution E12: Mathematical discoveries from program search with large language models](architecture/evolution-papers/E12.md)
- [Evolution E13: DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines](architecture/evolution-papers/E13.md)
<!-- evolution-paper-notes:end -->
- [architecture/evolution-research-directions.md](architecture/evolution-research-directions.md) — proposed changes to experience learning, candidate search, skill routing, and harness evolution, with staged experiments
- [architecture/evolution-first-loop.md](architecture/evolution-first-loop.md) — the direction for C1/C2/C5: what the platform owns and why, the order the cost arithmetic forces, the five refusals, and the three-arm first experiment
- [architecture/code-evolution-loop.md](architecture/code-evolution-loop.md) — code evolution: a delegated coding agent mutates the harness repo, everdict builds the image into its own store, the campaign decides
- [architecture/evolution-routing-spec.md](architecture/evolution-routing-spec.md) — spec: WHO from the slot's maintainer, WHAT from attributed evidence, the issue binds the cases, the gate verifies the targets flipped, build sets, memory across campaigns
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
- [auth.md](auth.md) — the auth core (`@everdict/auth`): OIDC + API keys + agent/runner/GitHub Actions tokens → `Principal`; membership-backed roles, role/scope authZ
- [tenancy.md](tenancy.md) — tenant access layer: workspace = tenant = trust zone, tenant-owned entities, scoped reads
- [secrets.md](secrets.md) — workspace secret management: encrypted-at-rest model/provider keys, injected per-tenant into runs
- [architecture/workspace-scoped-integrations.md](architecture/workspace-scoped-integrations.md) — workspace-owned GitHub App + Mattermost (replacing personal Connected accounts)
- [architecture/github-actions-trigger.md](architecture/github-actions-trigger.md) — CI-fired evals + zero-input repo↔service integration
- [runbooks/corporate-proxy.md](runbooks/corporate-proxy.md) — runbook: deploying behind a corporate proxy

## Billing & metrics
- [usage-metering.md](usage-metering.md) — the usage PROXY: a sidecar that recovers per-run token usage from a black-box harness's model calls → `budget.settle` (the billing meter is architecture/usage-metering.md)
- [architecture/usage-metering.md](architecture/usage-metering.md) — the billing METER: what is recorded per run, where it is wired, and the web view (the token-capturing proxy is usage-metering.md)
- [architecture/metrics-commercialization.md](architecture/metrics-commercialization.md) — two products, three bundles, one closed scrape

## Database migrations
- [migration/README.md](migration/README.md) — migration discipline (expand → deploy → contract, preflight checks)
- Per-migration preflight records: [0001_create_runs](migration/preflight/0001_create_runs.md) · [0002_create_harnesses](migration/preflight/0002_create_harnesses.md) · [0003_create_tenant_keys](migration/preflight/0003_create_tenant_keys.md) · [0004_harness_tenant](migration/preflight/0004_harness_tenant.md) · [0200_trajectory_events](migration/preflight/0200_trajectory_events.md) · [0212-drop-team-axis](migration/preflight/0212-drop-team-axis.md) · [0215-remove-team-era-facts](migration/preflight/0215-remove-team-era-facts.md) · [0216-drop-knowledge-graph](migration/preflight/0216-drop-knowledge-graph.md)

## The documentation itself
- [architecture/document-kinds.md](architecture/document-kinds.md) — the four kinds a document can be (wiki · decision · spec · runbook), what each owes, and how each is allowed to change
- [architecture/docs-site-removal.md](architecture/docs-site-removal.md) — documentation ships in this repository; the published site was removed as a duplicate surface
- [architecture/sdlc-out-of-the-repository.md](architecture/sdlc-out-of-the-repository.md) — the development process left the repository on 2026-09-15: what was removed, what stays, what is no longer enforced, and how accumulating it in Everdict will be verified
- [architecture/repository-layout.md](architecture/repository-layout.md) — *(superseded)* the root folded to 11 directories with the process records under `docs/sdlc/`, kept for its measured rejections
- [architecture/docs-site.md](architecture/docs-site.md) — *(superseded)* the plan for the Docusaurus site, kept for §2.0's measured rejection of relocating files

## Internals — historical design records
> Written during the re-architecture review and **not maintained since**. The umbrella migration SHIPPED on
> 2026-07-10; the per-domain collaboration models were removed on 2026-09-15 once their reasoning lived in the
> pages above, the skills and the code (`docs/architecture/repository-layout.md`). The target architecture stays
> because three package barrels cite it and it alone records the P4 resolutions. Read it for the reasoning, not
> the addresses.

- [architecture/rearchitecture/00-target-architecture.md](architecture/rearchitecture/00-target-architecture.md) — the target architecture (SHIPPED)
- [architecture/api-route-modularization.md](architecture/api-route-modularization.md) — why `apps/api` is per-resource route/MCP/docs modules and `ScorecardService` is a facade (shipped; business code later moved to packages)
- [architecture/rich-domain-core.md](architecture/rich-domain-core.md) — the domain expresses itself: transitions return `{patch, facts}`, policies in `packages/domain`
