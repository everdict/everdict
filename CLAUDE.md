# Everdict — Agent Harness Evaluation Runtime

> Everdict = **eval + verdict**: run any agent harness, get a defensible verdict.
> A **harness-agnostic, infra-agnostic** runtime that runs and **evaluates** arbitrary
> agent harnesses (Claude Code, Codex, LangGraph, …) across environments (repo / browser /
> os-use) and OSes (Linux / Windows / macOS). Eval-first; just enough operational runtime
> to drive long/stateful/isolated runs.

## 🚨 Documentation-first — read before you code
Always read the relevant skill in `.claude/skills/` **before** writing code. No exceptions.
Read the matching `<area>/SKILL.md` first, then pull `references/*.md` on demand.
`.claude/` is the **single source of truth** for how we build.

## Language policy (public repo — English-only source)
- Everything in the repo is **English**: docs, code comments, log/error messages, OpenAPI summaries,
  test descriptions, commit messages, PR titles/bodies.
- The ONLY Korean in the repo is **ko-locale product data**: `apps/web/messages/ko.json` and inline
  ko-locale dictionaries/fallbacks (e.g. `shared/lib/{format,clipboard,cron}`), plus test assertions
  on that ko output.
- Web UI strings → **message catalogs** (`ko`/`en`), never hardcoded in components (see `docs/web.md`).
- Conversation with the maintainer stays Korean (preference); repo artifacts do not.

## Essential commands (run in this order)
1. `pnpm format`   — Biome format (always first)
2. `pnpm lint`     — Biome check (format + lint, single tool = ktlint reinterpretation)
3. `pnpm typecheck`— `tsc --noEmit` across packages (turbo)
4. `pnpm test`     — Vitest across packages (turbo)
5. `pnpm build`    — turbo build
Quality is non-negotiable: all five must pass before a PR.
**Before ANY `git push`: `pnpm ci:local`** — mirrors the FULL GitHub Actions CI (the five commands
above PLUS `pnpm cone` + `pnpm web-imports` + empty-env boot + the self-contained web job + full-history
gitleaks) and stamps `.git/everdict-ci-ok` on a clean green tree; a PreToolUse hook denies unstamped
pushes. `.github/workflows/ci.yml` is the SSOT; see rule `.claude/rules/ci.md` + skill `ci`. Never push
red; after pushing, confirm the run went green (`gh run watch … --exit-status`).

## Architecture — one-way dependency, by concern
```
contracts ← domain ← { application-execution · application-control } ← { drivers · environments · harnesses · graders · trace · db · registry · backends · auth · storage } ← agent ← { orchestrator · topology } ← self-hosted-runner ← { apps/cli · apps/desktop }
```
The **layer spine** is `contracts ← domain ← application-{execution,control}`: contracts is the pure dependency ROOT (interfaces + Zod schemas + errors), domain adds the pure business kernel (aggregates, version algebra, scoring/suite semantics, authz matrix, policy), and the two application layers hold the use-cases + ports the adapter packages bind. (The former `@everdict/{core,suite,run-case,billing}` packages were folded into this spine in the re-architecture.)
- `packages/contracts`    — contracts only (interfaces + Zod schemas + errors + the job-result wire codec). Dependency ROOT. No I/O, no SDKs. The `@everdict/contracts/wire` subpath is the web's type-only surface.
- `packages/domain`       — the pure business kernel over contracts: the rich aggregates (Run/ScorecardBatch/Membership/Schedule), version algebra (`compareVersions`/`resolveRef`/`specsEqual`), scoring + suite semantics (`caseVerdict`/`summarizeScorecard`/`diffScorecards`/`classifyFailure`/trials), the role→action authz matrix, and placement policy (FairQueue/CircuitBreaker/Autoscaler/TrustZonePolicy). No I/O.
- `packages/application-execution` — the in-sandbox eval use-cases: `runCase` (the eval loop), `safeGrade`, trace/observation scoring. Depends only on contracts+domain.
- `packages/application-control` — the control-plane use-cases + the ports the adapters bind: `runSuite`, store ports (`RunStore`/`ScorecardStore`/…), registry ports, the `Dispatcher` port, `ArtifactStore` + `offloadSnapshot`, the credential primitives (`generateKey`/`hashKey`/`generateInviteToken`), scheduling/ops orchestration, `Metrics`. Impls live in the adapter packages that depend on it.
- `packages/drivers`      — *in-sandbox compute* (`ComputeHandle`): LocalDriver (dev / inside the agent).
- `packages/environments` — the world a run acts on (`RepoEnvironment`: seed + git-diff snapshot).
- `packages/harnesses`    — the agent under test, driven over a process boundary (ClaudeCodeHarness, ScriptedHarness, + declarative `CommandHarness` — any CLI agent from a `HarnessSpec(command)`, no code. See `docs/command-harness.md`).
- `packages/graders`      — scoring, fully separate from the harness (tests-pass / cost / steps / latency) + Agent Judge (`JudgeGrader` + `modelJudge` over an injected transport: `anthropicComplete` / `openaiComplete` [→LiteLLM] / `harnessComplete` [dispatch an agent, verdict from its trace] — LLM/VLM/agent verdict from a trace). See `docs/judges.md`.
- `packages/agent`        — the dispatched unit: a self-contained worker that runs `runCase` inside an isolated job and emits the result (the backend dispatches it, it does not run the harness itself).
- `packages/backends`     — *placement* (`Backend`): dispatch the agent to an orchestrator (LocalBackend, NomadBackend, K8sBackend [process→K8s Job, `runtimeClassName` isolation]; Windows later) + `Router` (static) / `Scheduler` (capacity-aware + tenant-fair WFQ + queue/backpressure) / `BackendRegistry` + `TrustZonePolicy` (per-tenant isolation: enforced hardened runtime + namespace + warm-pool keying) + `Autoscaler` (queue-depth elastic scaling) + `SecretProvider`/`BudgetTracker` (per-tenant key scoping + cost/run budgets) + `buildRuntimeBackend` (RuntimeSpec→live Backend, for tenant-registered runtimes; control-plane→cluster-API auth via `spec.authSecret`→SecretStore→`X-Nomad-Token`/`kubectl --token`, stripped from alloc env — see `docs/runtimes.md`).
- `packages/orchestrator` — durable control plane on Temporal: `DirectOrchestrator` / `TemporalOrchestrator` + the worker (workflow=deterministic, activity=`dispatchCase`).
- `packages/trace`        — pull a harness trace from the tenant's platform → normalized `TraceEvent`; `buildTraceSource(cfg)` (kind: otel|mlflow|langfuse|langsmith|phoenix) powers pull-mode scorecard ingest. + **outbound `TraceSink`** (`buildTraceSink`: mlflow|langfuse|langsmith|phoenix) — export judged case trace+scores to the tenant's observability platform (create-or-attach per case; MLflow incl. best-effort OTLP/JSON spans, live-verified 3.11/3.14). See `docs/architecture/trace-sink.md`.
- `packages/topology`     — **service-topology** harnesses (multi-service + target env): `HarnessSpec(service)`, orchestrator-agnostic `ServiceTopologyBackend` + Nomad/K8s topology builders + runId-keyed env manager. See `docs/service-harness.md`.
- `packages/db`           — result stores: `RunStore` (single runs) + `ScorecardStore` (batch eval = dataset×harness → aggregated `Scorecard`+summary; `list` omits heavy per-case results) + `ViewStore` (saved scorecard-analysis views — config `jsonb`, `private|workspace` visibility) — `InMemory*` / `Pg*` on Postgres + numbered SQL migrations + idempotent `migrate`/`preflight`. See `docs/migration/` + `docs/scorecards.md`.
- `packages/registry`     — **versioned SSOT** (harnesses + datasets + judges + runtimes): `(tenant, id, version) → HarnessSpec` / `→ Dataset` / `→ JudgeSpec` / `→ RuntimeSpec` (immutable versions, semver `latest`, tenant-owned + `_shared` fallback; in-memory / file-GitOps / Postgres `Pg*Registry` — async interface); `ServiceTopologyBackend.specFor` wires to the harness registry. Datasets are **harness-agnostic**; **Agent Judges** are user-registered `model`|`harness` specs; **Runtimes** are user-registered execution infra (local|nomad|k8s; `local` = dev/control-plane-host, superseded for "my machine" by the self-hosted runner). See `docs/registry.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md`.
- `packages/auth`         — **control-plane auth core**: `Authenticator` → `Principal{subject,workspace,roles,via}` (OIDC/Keycloak JWT via `jose` JWKS + API-key `ak_…`, `compositeAuthenticator`) + role→action authZ (`can`/`authorize`). `workspace=tenant=trust-zone`. See `docs/auth.md`.
- `packages/self-hosted-runner`  — **self-hosted runner core** shared by CLI + desktop: MCP lease loop (`runLeaseWorkers`), resilient session (`ResilientMcpSession`), harness-kind branch execution (`runLeasedJob`: service→Docker topology / else→`runAgentJob`). GUI-free, transport-injectable. See `docs/architecture/desktop-app.md` + `docs/architecture/self-hosted-runner.md`.
- `apps/cli`              — dev/single-run control plane (`everdict run [--orchestrator temporal]`, `everdict worker`) + `everdict runner` (thin wrapper over `@everdict/self-hosted-runner`).
- `apps/api`              — **multi-tenant control-plane HTTP surface** (Fastify): owns auth (`@everdict/auth`: OIDC + API keys → `Principal`, role-gated routes, `GET /me`), tenant-owned harnesses (`POST/GET /harnesses`), tenant-owned + `_shared` datasets (`POST/GET /datasets`, harness-agnostic eval-case bundles), user-registered + `_shared` Agent Judges (`POST/GET /judges`, `model`(LLM/VLM call) | `harness`(delegate)), user-registered + `_shared` Runtimes (`POST/GET /runtimes`, local|nomad|k8s execution infra; `RuntimeDispatcher` routes a tenant's run to its chosen runtime), async batch evals (`POST/GET /scorecards`, dataset×harness → aggregated `Scorecard`+summary via `runSuite`, + selected judges applied to each trace → `judge:<id>` scores; model judges call the provider with the tenant's SecretStore key; `GET /scorecards/diff` = baseline↔candidate regressions/improvements; `POST /scorecards/ingest` = score externally-run `TraceEvent[]` with no harness run [push]; `POST /scorecards/ingest/pull` = pull traces from a tenant's OTel/MLflow [MLflow 3.x `/api/3.0/.../traces/get`, OTLP spans] via `@everdict/trace` `buildTraceSource` [`source.authSecret`→SecretStore value→verbatim `Authorization` header: `Bearer …`/`Basic …`] then score [pull; live-verified vs MLflow 3.11.1]), saved scorecard-analysis **Views** (`POST/GET/PATCH/DELETE /views` — `private|workspace` saved lenses over `listScorecards`, re-run live on open; edit/delete = creator or admin; authz **reuses** `scorecards:read`/`scorecards:run`, no new action), **workspace GitHub App integration** (`GET/POST/DELETE /workspace/github-app*` — org install→selected repos→**workspace-owned** installation tokens that GitHub scopes to the chosen repos; used for private clone/CI setup-PR/runner registration; github.com App via operator env, GHE App workspace-registered [host+App ID+private-key SecretStore ref]; `settings:write`) + **workspace Mattermost** (`GET/PUT/DELETE /workspace/mattermost` — bot-token completion/regression channel notifications, self-serve admin registration) + **workspace trace sources** (the ONE observability-platform registration pool `GET/PUT /workspace/trace-sources` + `DELETE …/:name` + `POST …/probe` [connect→scope-discovery, settings:write]; a harness uses a source to PULL its trace from `PUT /harnesses/:id/trace-source` and/or to EXPORT judged detail to `PUT /harnesses/:id/trace-sink` [both member+, opt-in — the "sink" is a trace source used as an export target, otel excluded]; mlflow/phoenix require a scope [experiment/project] at register time; export outcome on `ScorecardRecord.export` [status/link/per-case external id, mig 0048], failure never fails the scorecard; pull-ingest with matching source kind **attaches scores to the original traces** instead of duplicating; browse + inspect [`…/:name/traces`, `…/traces/:id/inspect` → structured span waterfall] powers Settings › Observability — see `docs/architecture/trace-sink.md`) + **workspace image registries (multiple)** (`GET/PUT /workspace/image-registries` + `DELETE …/:name` + `POST …/push-credentials?name=` [name required if multiple] — BYO registries as the image-provenance baseline: `classifyImageRef` 4-class [workspace/external/local/unqualified], harness register/validate `imageWarnings`, member-gated push-credential mint [`images:push`] consumed by `everdict image push` — see `docs/architecture/workspace-image-registry.md`), **CI triggers (GitHub Actions)** (PR = submit-time ephemeral `harness.pins` image swap recorded in `ScorecardRecord.origin.pinOverrides`; PR comment `/evaluate` = on-demand re-evaluation[issue_comment, collaborator gate+PR head checkout+reply in thread; link `trigger` auto|comment|both]; merge = `POST /harnesses/:id/pins` headless re-pin → new immutable instance version; repo links `GET/PUT/DELETE /workspace/ci/links` [link = OIDC trust policy] + `GET /workspace/github-app/repos` picker + `POST /workspace/ci/links/setup-pr` workflow generator; keyless auth via GitHub Actions OIDC federation → `ci` role — see `docs/architecture/github-actions-trigger.md`), `POST /internal/tenant-keys` ({workspace}), async `POST /runs`→run-id + workspace-scoped reads, `RunStore`/`ScorecardStore` (in-memory or Postgres via `DATABASE_URL`), and the agent-facing **MCP server** (`/mcp`, Streamable HTTP, OAuth-protected via Keycloak "login like Linear" + API keys, role-gated tools — full BFF↔MCP parity for runs/harnesses/datasets/judges/runtimes/scorecards/views/github-app/mattermost). See `docs/api.md` + `docs/auth.md` + `docs/mcp.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md` + `docs/scorecards.md` + `docs/architecture/scorecard-analysis-views.md` + `docs/architecture/workspace-scoped-integrations.md` + `docs/tenancy.md`.
- `apps/web`              — **SaaS web** (Next.js 16 App Router, FSD, Tailwind v4 + shadcn Toss-style): Keycloak (Auth.js) user login; a **token courier** — forwards the Keycloak access token as `Bearer` to the control plane and gets `workspace`/roles from `GET /me` (role-gated UI; control plane enforces). Per-workspace dashboard (runs/harnesses/datasets/judges/runtimes/scorecards/views) + workspace Settings (secrets · members · integrations[GitHub App·Mattermost]) + personal **account** page (profile · personal secrets · API keys). Self-contained eslint+prettier (excluded from root Biome). Pure HTTP client of the control plane; runtime-decoupled — the only allowed `@everdict` dep is TYPE-ONLY `@everdict/contracts` (wire/record types, re-architecture P4; local zod v4 schemas keep runtime validation, drift-guarded against the contract types). See `docs/web.md` + `docs/auth.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md` + `docs/scorecards.md` + `docs/architecture/workspace-scoped-integrations.md`. (Humans→Keycloak; agents→API keys/MCP.)
- `apps/desktop`          — **Electron desktop shell**: renders the *deployed* `apps/web` in a BrowserWindow (full web parity by construction — zero UI re-implementation; desktop-aware UI = `window.everdictDesktop`-conditional branches inside `apps/web`) + resident self-hosted runner (`@everdict/self-hosted-runner` in the main process, one-click pairing via an origin-gated preload bridge, `rnr_` token in `safeStorage`). Tray-resident (close = hide). Security invariants + conventions: `.claude/skills/desktop/SKILL.md`. See `docs/architecture/desktop-app.md`.
Reverse imports are bugs. The same concern name recurs per package (vertical slices).

**Intra-package layout:** a package's `src/` stays flat until ~15 non-test files; beyond that, group into
**domain** subdirectories (tests colocated) with the barrel `index.ts` + the package's core contract kept at the
root. The barrel re-exports the same symbols, so grouping never changes the public surface (consumers are untouched).
See `packages/backends` (`placement`/`orchestrators`/`scheduling`/`policy`), `contracts` (`execution`/`harness`/`infra`/`records`),
`trace` (`sources`/`sinks`); `apps/web` (FSD) is the reference for large apps. Small packages stay flat by design.

### Two execution layers: Backend (placement) vs Driver (in-sandbox)
- **Backend** (`@everdict/backends`) = *placement*: dispatch a runner-agent job to an orchestrator
  (Nomad/K8s/Windows) and return the `CaseResult`. Isolation = the orchestrator's runtime.
- **Driver** (`@everdict/contracts`/`drivers`) = *in-sandbox compute*: the agent runs the harness via
  `LocalDriver` inside its already-isolated job. See `docs/execution-backends.md`.

### ⚠️ Deliberate deviation: interfaces ARE used
Single-implementation codebases rightly ban interfaces for DI (exactly one impl per concept).
Everdict's *whole product* is pluggable adapters (many Backends / Drivers / Harnesses / Graders), so the
`@everdict/contracts` contracts MUST be interfaces. This is the one idiom we intentionally invert —
everywhere else (null discipline, error model, naming, layering) we keep the strict default.

## Critical rules (the non-default ones — see `.claude/rules/`)
- No `any`, no non-null `!`, no silent nullable defaults; validate every boundary with Zod.
- Errors: throw an `AppError` subclass (`@everdict/contracts`); HTTP status derives from the subtype.
- External/SDK failures are remapped to our `AppError` (never propagated raw) so monitoring blames us, not the user.
- Cost/tokens come from the harness's own trace (e.g. Claude reports `total_cost_usd`); for LocalDriver the harness uses the machine's existing login (no API key).
- `ComputeHandle` is always released in a `finally`.
- Backends never run the harness; they dispatch the `@everdict/agent` image and parse its `__EVERDICT_RESULT__` stdout sentinel.
- Temporal workflow code (`@everdict/orchestrator` `workflows.ts`) MUST be deterministic — no I/O; side effects go in activities.

## Key principles
1. **Read first, code second — NO EXCEPTIONS.**
2. **Quality is non-negotiable** — format/lint/typecheck/test/build all green.
3. **Skills travel with the code** — a PR that changes a convention/invariant updates the matching skill reference *in the same PR* (mere implementation churn is not a doc trigger).
4. **Reinterpret, don't copy** — proven idioms from prior codebases are adapted to TS, not transplanted verbatim; note the source idea when non-obvious.

## Commits
Conventional Commits, scoped: `feat(drivers): ...`, `fix(runner): ...`. Body explains the *why*.
Every `fix:` ships a regression test that fails on the pre-fix code.
