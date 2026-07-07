# Assay — Agent Harness Evaluation Runtime

> Assay = "to assay": to determine the quality/composition of something.
> A **harness-agnostic, infra-agnostic** runtime that runs and **evaluates** arbitrary
> agent harnesses (Claude Code, Codex, LangGraph, …) across environments (repo / browser /
> os-use) and OSes (Linux / Windows / macOS). Eval-first; just enough operational runtime
> to drive long/stateful/isolated runs.

## 🚨 Documentation-first — read before you code
Always read the relevant skill in `.claude/skills/` **before** writing code. No exceptions.
Read the matching `<area>/SKILL.md` first, then pull `references/*.md` on demand.
`.claude/` is the **single source of truth** for how we build.

## Language policy
- `.claude/skills/` + `.claude/rules/` bodies → **English**.
- Code comments + OpenAPI `summary` → **Korean**.
- User-facing communication → **Korean**.

## Essential commands (run in this order)
1. `pnpm format`   — Biome format (always first)
2. `pnpm lint`     — Biome check (format + lint, single tool = ktlint reinterpretation)
3. `pnpm typecheck`— `tsc --noEmit` across packages (turbo)
4. `pnpm test`     — Vitest across packages (turbo)
5. `pnpm build`    — turbo build
Quality is non-negotiable: all five must pass before a PR.

## Architecture — one-way dependency, by concern
```
core ← { drivers · environments · harnesses · graders · trace } ← runner ← agent ← backends ← { orchestrator · topology · suite } ← runner-core ← { apps/cli · apps/desktop }
```
- `packages/core`         — contracts only (interfaces + Zod schemas + errors). Dependency ROOT. No I/O, no SDKs.
- `packages/drivers`      — *in-sandbox compute* (`ComputeHandle`): LocalDriver (dev / inside the agent).
- `packages/environments` — the world a run acts on (`RepoEnvironment`: seed + git-diff snapshot).
- `packages/harnesses`    — the agent under test, driven over a process boundary (ClaudeCodeHarness, ScriptedHarness, + declarative `CommandHarness` — any CLI agent from a `HarnessSpec(command)`, no code. See `docs/command-harness.md`).
- `packages/graders`      — scoring, fully separate from the harness (tests-pass / cost / steps / latency) + Agent Judge (`JudgeGrader` + `modelJudge` over an injected transport: `anthropicComplete` / `openaiComplete` [→LiteLLM] / `harnessComplete` [dispatch an agent, verdict from its trace] — LLM/VLM/agent verdict from a trace). See `docs/judges.md`.
- `packages/runner`       — the eval loop (`runCase`).
- `packages/agent`        — the dispatched unit (model B): runs `runCase` inside an isolated job, emits the result.
- `packages/backends`     — *placement* (`Backend`): dispatch the agent to an orchestrator (LocalBackend, NomadBackend, K8sBackend [process→K8s Job, `runtimeClassName` isolation]; Windows later) + `Router` (static) / `Scheduler` (capacity-aware + tenant-fair WFQ + queue/backpressure) / `BackendRegistry` + `TrustZonePolicy` (per-tenant isolation: enforced hardened runtime + namespace + warm-pool keying) + `Autoscaler` (queue-depth elastic scaling) + `SecretProvider`/`BudgetTracker` (per-tenant key scoping + cost/run budgets) + `buildRuntimeBackend` (RuntimeSpec→live Backend, for tenant-registered runtimes; control-plane→cluster-API auth via `spec.authSecret`→SecretStore→`X-Nomad-Token`/`kubectl --token`, stripped from alloc env — see `docs/runtimes.md`).
- `packages/orchestrator` — durable control plane on Temporal: `DirectOrchestrator` / `TemporalOrchestrator` + the worker (workflow=deterministic, activity=`dispatchCase`).
- `packages/trace`        — pull a harness trace from the tenant's platform → normalized `TraceEvent`; `buildTraceSource(cfg)` (kind: otel|mlflow|langfuse|langsmith|phoenix) powers pull-mode scorecard ingest. + **outbound `TraceSink`** (`buildTraceSink`: mlflow|langfuse|langsmith|phoenix) — export judged case trace+scores to the tenant's observability platform (create-or-attach per case; MLflow incl. best-effort OTLP/JSON spans, live-verified 3.11/3.14). See `docs/architecture/trace-sink.md`.
- `packages/topology`     — **service-topology** harnesses (multi-service + target env): `HarnessSpec(service)`, orchestrator-agnostic `ServiceTopologyBackend` + Nomad/K8s topology builders + runId-keyed env manager. See `docs/service-harness.md`.
- `packages/suite`        — suites + **version regression**: `runSuite` / `summarizeScorecard` / `diffScorecards` (over any backend). See `docs/suites.md`.
- `packages/db`           — result stores: `RunStore` (single runs) + `ScorecardStore` (batch eval = dataset×harness → aggregated `Scorecard`+summary; `list` omits heavy per-case results) + `ViewStore` (saved scorecard-analysis views — config `jsonb`, `private|workspace` visibility) — `InMemory*` / `Pg*` on Postgres + numbered SQL migrations + idempotent `migrate`/`preflight`. See `docs/migration/` + `docs/scorecards.md`.
- `packages/registry`     — **versioned SSOT** (harnesses + datasets + judges + runtimes): `(tenant, id, version) → HarnessSpec` / `→ Dataset` / `→ JudgeSpec` / `→ RuntimeSpec` (immutable versions, semver `latest`, tenant-owned + `_shared` fallback; in-memory / file-GitOps / Postgres `Pg*Registry` — async interface); `ServiceTopologyBackend.specFor` wires to the harness registry. Datasets are **harness-agnostic**; **Agent Judges** are user-registered `model`|`harness` specs; **Runtimes** are user-registered execution infra (local|nomad|k8s; `local` = dev/control-plane-host, superseded for "my machine" by the self-hosted runner). See `docs/registry.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md`.
- `packages/auth`         — **control-plane auth core**: `Authenticator` → `Principal{subject,workspace,roles,via}` (OIDC/Keycloak JWT via `jose` JWKS + API-key `ak_…`, `compositeAuthenticator`) + role→action authZ (`can`/`authorize`). `workspace=tenant=trust-zone`. See `docs/auth.md`.
- `packages/runner-core`  — **self-hosted runner core** shared by CLI + desktop: MCP lease loop (`runLeaseWorkers`), resilient session (`ResilientMcpSession`), harness-kind branch execution (`runLeasedJob`: service→Docker topology / else→`runAgentJob`). GUI-free, transport-injectable. See `docs/architecture/desktop-app.md` + `docs/architecture/self-hosted-runner.md`.
- `apps/cli`              — dev/single-run control plane (`assay run [--orchestrator temporal]`, `assay worker`) + `assay runner` (thin wrapper over `@assay/runner-core`).
- `apps/api`              — **multi-tenant control-plane HTTP surface** (Fastify): owns auth (`@assay/auth`: OIDC + API keys → `Principal`, role-gated routes, `GET /me`), tenant-owned harnesses (`POST/GET /harnesses`), tenant-owned + `_shared` datasets (`POST/GET /datasets`, harness-agnostic eval-case bundles), user-registered + `_shared` Agent Judges (`POST/GET /judges`, `model`(LLM/VLM call) | `harness`(delegate)), user-registered + `_shared` Runtimes (`POST/GET /runtimes`, local|nomad|k8s execution infra; `RuntimeDispatcher` routes a tenant's run to its chosen runtime), async batch evals (`POST/GET /scorecards`, dataset×harness → aggregated `Scorecard`+summary via `runSuite`, + selected judges applied to each trace → `judge:<id>` scores; model judges call the provider with the tenant's SecretStore key; `GET /scorecards/diff` = baseline↔candidate regressions/improvements; `POST /scorecards/ingest` = score externally-run `TraceEvent[]` with no harness run [push]; `POST /scorecards/ingest/pull` = pull traces from a tenant's OTel/MLflow [MLflow 3.x `/api/3.0/.../traces/get`, OTLP spans] via `@assay/trace` `buildTraceSource` [`source.authSecret`→SecretStore value→verbatim `Authorization` header: `Bearer …`/`Basic …`] then score [pull; live-verified vs MLflow 3.11.1]), saved scorecard-analysis **Views** (`POST/GET/PATCH/DELETE /views` — `private|workspace` saved lenses over `listScorecards`, re-run live on open; edit/delete = creator or admin; authz **reuses** `scorecards:read`/`scorecards:run`, no new action), **workspace GitHub App integration** (`GET/POST/DELETE /workspace/github-app*` — org install→selected repos→**workspace-owned** installation tokens that GitHub scopes to the chosen repos; used for private clone/CI setup-PR/runner registration; github.com App via operator env, GHE App workspace-registered [host+App ID+private-key SecretStore ref]; `settings:write`) + **workspace Mattermost** (`GET/PUT/DELETE /workspace/mattermost` — bot-token completion/regression channel notifications, self-serve admin registration) + **workspace trace sinks** (`GET/PUT /workspace/trace-sinks` + `DELETE …/:name`, **per-harness selection** `PUT /harnesses/:id/trace-sink` [member+, opt-in — no selection = no export] — export judged scorecard detail to the team's MLflow/Langfuse/LangSmith/Phoenix after judging; outcome on `ScorecardRecord.export` [status/링크/케이스별 외부 id, mig 0048], failure never fails the scorecard; pull-ingest with matching source kind **attaches scores to the original traces** instead of duplicating — see `docs/architecture/trace-sink.md`) + **workspace image registries(복수)** (`GET/PUT /workspace/image-registries` + `DELETE …/:name` + `POST …/push-credentials?name=` [복수면 이름 필수] — BYO registries as the image-provenance baseline: `classifyImageRef` 4-class [workspace/external/local/unqualified], harness register/validate `imageWarnings`, member-gated push-credential mint [`images:push`] consumed by `assay image push` — see `docs/architecture/workspace-image-registry.md`), **CI triggers (GitHub Actions)** (PR = submit-time ephemeral `harness.pins` image swap recorded in `ScorecardRecord.origin.pinOverrides`; PR 코멘트 `/evaluate` = 온디맨드 재평가[issue_comment, 협력자 게이트+PR head 체크아웃+대화 회신; link `trigger` auto|comment|both]; merge = `POST /harnesses/:id/pins` headless re-pin → new immutable instance version; repo links `GET/PUT/DELETE /workspace/ci/links` [link = OIDC trust policy] + `GET /workspace/github-app/repos` picker + `POST /workspace/ci/links/setup-pr` workflow generator; keyless auth via GitHub Actions OIDC federation → `ci` role — see `docs/architecture/github-actions-trigger.md`), `POST /internal/tenant-keys` ({workspace}), async `POST /runs`→run-id + workspace-scoped reads, `RunStore`/`ScorecardStore` (in-memory or Postgres via `DATABASE_URL`), and the agent-facing **MCP server** (`/mcp`, Streamable HTTP, OAuth-protected via Keycloak "login like Linear" + API keys, role-gated tools — full BFF↔MCP parity for runs/harnesses/datasets/judges/runtimes/scorecards/views/github-app/mattermost). See `docs/api.md` + `docs/auth.md` + `docs/mcp.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md` + `docs/scorecards.md` + `docs/architecture/scorecard-analysis-views.md` + `docs/architecture/workspace-scoped-integrations.md` + `docs/tenancy.md`.
- `apps/web`              — **SaaS web** (Next.js 16 App Router, FSD, Tailwind v4 + shadcn Toss-style): Keycloak (Auth.js) user login; a **token courier** — forwards the Keycloak access token as `Bearer` to the control plane and gets `workspace`/roles from `GET /me` (role-gated UI; control plane enforces). Per-workspace dashboard (runs/harnesses/datasets/judges/runtimes/scorecards/views) + workspace Settings (secrets · members · 통합[GitHub App·Mattermost]) + personal **계정**/account page (profile · 개인 시크릿 · API keys). Self-contained eslint+prettier (excluded from root Biome). Pure HTTP client of `@assay/api` (no `@assay/*` deps). See `docs/web.md` + `docs/auth.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md` + `docs/scorecards.md` + `docs/architecture/workspace-scoped-integrations.md`. (Humans→Keycloak; agents→API keys/MCP.)
- `apps/desktop`          — **Electron desktop shell**: renders the *deployed* `apps/web` in a BrowserWindow (full web parity by construction — zero UI re-implementation; desktop-aware UI = `window.assayDesktop`-conditional branches inside `apps/web`) + resident self-hosted runner (`@assay/runner-core` in the main process, one-click pairing via an origin-gated preload bridge, `rnr_` token in `safeStorage`). Tray-resident (close = hide). Security invariants + conventions: `.claude/skills/desktop/SKILL.md`. See `docs/architecture/desktop-app.md`.
Reverse imports are bugs. The same concern name recurs per package (vertical slices).

### Two execution layers (Backend vs Driver) — model B
- **Backend** (`@assay/backends`) = *placement*: dispatch a runner-agent job to an orchestrator
  (Nomad/K8s/Windows) and return the `CaseResult`. Isolation = the orchestrator's runtime.
- **Driver** (`@assay/core`/`drivers`) = *in-sandbox compute*: the agent runs the harness via
  `LocalDriver` inside its already-isolated job. See `docs/execution-backends.md`.

### ⚠️ Deliberate deviation: interfaces ARE used
Single-implementation codebases rightly ban interfaces for DI (exactly one impl per concept).
Assay's *whole product* is pluggable adapters (many Backends / Drivers / Harnesses / Graders), so the
`core` contracts MUST be interfaces. This is the one idiom we intentionally invert —
everywhere else (null discipline, error model, naming, layering) we keep the strict default.

## Critical rules (the non-default ones — see `.claude/rules/`)
- No `any`, no non-null `!`, no silent nullable defaults; validate every boundary with Zod.
- Errors: throw an `AppError` subclass (`@assay/core`); HTTP status derives from the subtype.
- External/SDK failures are remapped to our `AppError` (never propagated raw) so monitoring blames us, not the user.
- Cost/tokens come from the harness's own trace (e.g. Claude reports `total_cost_usd`); for LocalDriver the harness uses the machine's existing login (no API key).
- `ComputeHandle` is always released in a `finally`.
- Backends never run the harness; they dispatch the `@assay/agent` image and parse its `__ASSAY_RESULT__` stdout sentinel.
- Temporal workflow code (`@assay/orchestrator` `workflows.ts`) MUST be deterministic — no I/O; side effects go in activities.

## Key principles
1. **Read first, code second — NO EXCEPTIONS.**
2. **Quality is non-negotiable** — format/lint/typecheck/test/build all green.
3. **Skills travel with the code** — a PR that changes a convention/invariant updates the matching skill reference *in the same PR* (mere implementation churn is not a doc trigger).
4. **Reinterpret, don't copy** — proven idioms from prior codebases are adapted to TS, not transplanted verbatim; note the source idea when non-obvious.

## Commits
Conventional Commits, scoped: `feat(drivers): ...`, `fix(runner): ...`. Body explains the *why*.
Every `fix:` ships a regression test that fails on the pre-fix code.
