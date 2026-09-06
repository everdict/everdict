# Architecture reference

## Packages
The layer spine is `contracts ← domain ← application-{execution,control}`. The former
`@everdict/{core,suite,run-case,billing}` packages were folded into it: `core`→`contracts` (+ the
domain kernel), `run-case`→`application-execution`, `suite`→`application-control`, `billing`→`domain`.

| Package | Role | Depends on |
|---|---|---|
| `@everdict/contracts` | contracts: interfaces + Zod schemas + errors + job-result wire codec (`/wire`, `/records` subpaths) | (none) |
| `@everdict/domain` | pure business kernel: rich aggregates, version algebra, scoring/suite semantics (`caseVerdict`/`summarizeScorecard`/`diffScorecards`/`classifyFailure`/trials), authz matrix, placement policy (FairQueue/CircuitBreaker/Autoscaler/TrustZonePolicy) | contracts |
| `@everdict/application-execution` | in-sandbox use-cases: `runCase` (the eval loop), `safeGrade`, observation scoring | contracts, domain |
| `@everdict/application-control` | control-plane use-cases + ports adapters bind: `runSuite`, store/registry ports, the `Dispatcher` port, `ArtifactStore`/`offloadSnapshot`, credential primitives, scheduling/ops orchestration, `Metrics` | contracts, domain, application-execution |
| `@everdict/drivers` | `Driver` impls — in-sandbox compute (Local/Docker) | contracts |
| `@everdict/environments` | `Environment` impls — the world acted on (Repo) | contracts |
| `@everdict/harnesses` | `EvaluableHarness` impls — the agent under test | contracts |
| `@everdict/graders` | `Grader` impls — scoring | contracts, application-execution |
| `@everdict/trace` | pull a harness trace from OTel/MLflow → `TraceEvent` (+ outbound `TraceSink`); re-exports `TraceSource`/`TraceSink` from contracts beside the impls | contracts |
| `@everdict/db` | result/store impls (`InMemory*`/`Pg*`) + numbered SQL migrations + `migrate`/`preflight`; re-exports record types (contracts) + store ports (application-control) beside the impls | contracts, domain, application-control |
| `@everdict/registry` | versioned SSOT impls: `(tenant,id,version)→Spec`, immutable versions, file/GitOps + `Pg*Registry`; re-exports registry ports (application-control) beside the impls | contracts, domain, application-control, db, datasets |
| `@everdict/auth` | control-plane auth core: `Authenticator`→`Principal`, re-exports the authz vocabulary (domain) beside the authenticators | contracts, domain, db |
| `@everdict/storage` | `ArtifactStore` impls (S3/InMemory); re-exports the port + `offloadSnapshot` (application-control) beside the impls | contracts, application-control |
| `@everdict/backends` | `Backend` impls (+ `capacity()`) — placement (Local/Docker, Nomad, K8s) + `Router`/`Scheduler`/`BackendRegistry`; re-exports the `Dispatcher` port (application-control) beside `Backend` | contracts, domain, application-control, agent, drivers |
| `@everdict/job-runner` | dispatched unit: a self-contained worker that runs `runCase` inside a job, emits result | contracts, domain, application-execution, drivers, environments, harnesses, graders |
| `@everdict/orchestrator` | durable control plane (Temporal): Direct/Temporal orchestrators + worker | contracts, backends, agent |
| `@everdict/topology` | service-topology harnesses: `ServiceTopologyBackend` + Nomad/K8s builders + env manager | contracts, domain, application-execution, backends, graders, trace |
| `@everdict/self-hosted-runner` | self-hosted runner core (MCP lease loop, resilient session, kind-branch execution) | contracts, agent, topology, trace |
| `apps/cli` | dev control plane (`everdict run`, `everdict worker`, `everdict runner`) | contracts, agent, backends, orchestrator, application-control |
| `apps/api` | multi-tenant control-plane HTTP (Fastify): auth + tenant-owned harnesses/datasets/judges/runtimes + async runs/scorecards + MCP | contracts, domain, application-{execution,control}, agent, backends, db, registry, auth, storage, trace |
| `apps/web` | SaaS web (Next.js 16 FSD, Tailwind v4 + shadcn): Keycloak login + per-tenant dashboard | (HTTP client of apps/api; only TYPE-ONLY `@everdict/contracts`) |
| `@everdict/llm` | provider-NATIVE LLM transports (`LlmTransport`: Anthropic Messages API + OpenAI, native wire + prompt/KV caching). Deliberately NOT provider-agnostic-over-LiteLLM: `transportFor(provider)` speaks each provider's own protocol. `stream()` powers the agent loop, `complete()` the one-shot judges/probes; `openai-compatible` (custom `baseUrl`) is the explicit escape hatch for vLLM / a LiteLLM proxy, never the default | contracts |
| `@everdict/datasets` | task-format on-ramps: a Terminal-Bench task set (instruction + prebuilt image + `tests/` verifier) → `EvalCase[]`, plus benchmark adapters and `CaseMapping` rules for HF/jsonl/csv. Everdict REFERENCES images, never builds them (`resolveImage` throws). A task's `tests/` bytes and verifier env are VERIFIER-PRIVATE — see rule `protocol` and `verifierPlanOf` | contracts, domain |
| `@everdict/images` | adapters behind the `WorkspaceImages` port (managed image store): copy/mirror, provenance, in-memory + registry clients. A registry client is not object storage, which is why it is not in `storage` | contracts, application-control |
| `@everdict/agent-runtime` | the agent kernel: a domain-agnostic, Claude-Code-style agentic loop (turns over a `ToolRegistry`, ToolSearch progressive disclosure, context compaction, sub-agents, MCP bridging, the envelope + consent gates). Transport-injected — it does not know Everdict. Skill `agent-runtime` | contracts, llm |
| `@everdict/sdk` | the one-call developer surface over the control-plane HTTP API: a pure HTTP client of the public routes with type-only contract imports. **Nothing in the monorepo depends on it** | (type-only contracts) |
| `@everdict/otel` | user-facing OTLP-door helpers, dependency-free: `EVERDICT_SEMCONV` + resource/exporter config builders for sending traces TO everdict (`POST /v1/traces`). Python = env-only recipe. **Nothing in the monorepo depends on it** | (none) |
| `apps/agent` | Everdict's OWN agent, the reference owner runtime over `@everdict/agent-runtime`: workspace conversations, the tool surface (fs · code · runs · evals · integrations · skills · knowledge), activation/triggers, HITL approval, memory. It CONSUMES the trust harness and is not part of it | contracts, domain, application-control, agent-runtime, llm |
| `apps/desktop` | Electron shell: renders the *deployed* `apps/web` in a BrowserWindow (full web parity by construction; desktop-aware UI = `window.everdictDesktop`-conditional branches inside `apps/web`) + resident self-hosted runner in the main process, one-click pairing over an origin-gated preload bridge, `rnr_` token in `safeStorage`. Tray-resident. Skill `desktop` | self-hosted-runner |

## The eval loop (runs inside the agent)
```
runCase(case, { driver, environment, harness, graders, runCtx }):
  compute = driver.provision({ os, image, needs })
  try:
    environment.seed(compute, case.env)        # known initial state
    harness.install(compute)
    trace = []; for ev in harness.run(compute, case.task, runCtx): trace.push(ev)
    snapshot = environment.snapshot(compute)
    scores = await all(graders.map(g => g.grade({case, trace, snapshot, compute})))
    return { caseId, harness:`${id}@${version}`, trace, snapshot, scores }
  finally:
    compute.dispose()
```

## Distributed execution: Backend (placement) vs Driver (in-sandbox)
The control plane (outside the clusters) builds an `CaseJob` (`{evalCase, harness:{id,version}}`)
and calls `Backend.dispatch(job)`. The Backend dispatches the **job-runner** (`@everdict/job-runner`)
into an isolated unit; the agent reconstructs the harness+graders from a registry
(`makeHarness`/`makeGraders`; graders carry config via `GraderSpec`), runs the eval loop above via
`LocalDriver`, and prints the `CaseResult` behind the `__EVERDICT_RESULT__` sentinel; the Backend
parses it. Isolation is the orchestrator's (Nomad task `runtime` / K8s `runtimeClassName` /
Windows VM), not Everdict's. Backends: `LocalBackend` (in-process dev, never the
control plane), `NomadBackend` (batch alloc) and `K8sBackend` (process→K8s Job) — both live. A Windows target
is named in the placement comments as a future registration; there is no Windows backend class. See skill `backends` + `docs/execution-backends.md`.

Fan out cases × harness-versions; regression = run a suite against `harness@vA` and `@vB`, diff
scorecards. Durable dispatch+await is implemented in `@everdict/orchestrator` (Temporal):
`evalCaseWorkflow`/`suiteWorkflow` call the `dispatchCase` activity (which runs a `Dispatcher`); the
`everdict worker` holds the registry + a capacity-aware `Scheduler` (gates on `Backend.capacity()`,
queues when full, backpressure via `RateLimitError`), the client (`everdict run --orchestrator temporal`)
starts+awaits. `suiteWorkflow` fan-out is bounded. See `docs/orchestration.md` + `docs/execution-backends.md`.

## How new things plug in (no core rewrite)
- New compute target (Nomad / K8s / Windows pool) → new `Backend`; the agent + loop are unchanged.
- New OS env on a pool (Windows/macOS) → `Backend` + per-run VM-checkpoint isolation.
- New env type (browser / os-use) → new `Environment` + `EnvSnapshot` variant + grader family.
  os-use adds a `Computer` capability (screenshot/click/type) to `ComputeHandle` + a desktop image.
- New harness (Codex / LangGraph) → new `EvaluableHarness` adapter (+ a registry entry in `@everdict/job-runner`).
- New scoring signal → new `Grader` (+ a registry entry). Grader is the one scoring primitive (a model-backed
  Grader = an Agent Judge); the automatic passRate/mean summary needs no definition.

## Build status & order
Built: core → drivers(Local) → environments(Repo) → harnesses(claude-code/scripted) →
graders(tests-pass/cost/steps/latency) → runner → agent → backends(Local/Nomad) + Router/Registry →
orchestrator(Direct/Temporal + worker) → cli (`run`/`worker`).
Service-topology harnesses (browser-use-langgraph etc.): `@everdict/trace` (OTel/MLflow → TraceEvent) +
`@everdict/topology` (HarnessSpec(service), orchestrator-agnostic `ServiceTopologyBackend`, Nomad+K8s builders,
runId-keyed isolation) — Phase 1 built+tested; live runtimes/browser+ext provisioning = Phase 2. See
`docs/service-harness.md`.
Next: a Windows placement target; everything else in this paragraph's earlier drafts has landed.
