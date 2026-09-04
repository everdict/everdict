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

## 🚨 Review-first — load skill `code-review` before reviewing anything
ANY review — a diff, a branch, a PR, a batch before push, or a self-review of what you just wrote — starts by
loading skill `code-review` and running its six passes. No exceptions, and **especially not for a self-review**:
that is the case it was written for. Three self-review rounds over one batch found real defects and missed
three P0s an outside review found immediately, using no information the author did not have — because every
round reviewed the CHANGE and none asked who can author the values it made load-bearing. Reading the diff is
the last pass, not the first. A review that stops at "the gates are green" has reported the gates' opinion:
no gate here can see a forged capability, a bound composed with an unbounded neighbour, or SQL no engine has
planned.
The skill has now failed TWICE and been paid for twice. The second failure is the one to remember: six passes
all phrased "for every value **this change** …", against three P0s that lived in code the batch never touched
and had merely come to DEPEND on — a parser it cited instead of opening, a two-statement seal it started
reading as evidence, a sibling query it forgot to teach. Reviewing what you wrote is not the same as
reviewing what you now rest on.

## Language policy (public repo — English-only source)
- Everything in the repo is **English**: docs, code comments, log/error messages, OpenAPI summaries,
  test descriptions, commit messages, PR titles/bodies.
- The ONLY Korean in the repo is **ko-locale product data**: `apps/web/messages/ko.json` and inline
  ko-locale dictionaries/fallbacks (e.g. `shared/lib/{format,clipboard,cron}`), plus test assertions
  on that ko output, plus the ONE named agent-eval stimulus whose language IS the fixture
  (`evals/cases/english-only-source.json` — a Korean request that must still produce English source).
  Each further one is argued and listed individually, never by directory. The Korean is always an input
  under test, never the repository's own prose.
- Web UI strings → **message catalogs** (`ko`/`en`), never hardcoded in components (see `docs/web.md`).
- Conversation with the maintainer stays Korean (preference); repo artifacts do not.

## Essential commands (run in this order)
1. `pnpm format`   — Biome format (always first)
2. `pnpm lint`     — Biome check (format + lint, single tool = ktlint reinterpretation)
3. `pnpm typecheck`— `tsc --noEmit` across packages (turbo)
4. `pnpm test`     — Vitest across packages (turbo)
5. `pnpm build`    — turbo build
⚠️ `biome check --write` does NOT apply Biome's **unsafe** fixes and exits 0 anyway, so a file can come back
from it reporting success and still fail `pnpm lint`. Running the formatter is not evidence; `pnpm lint` after
it is. (Found by the agent-eval suite: asked "biome exited 0, is lint green?", the answer cited this file's
five commands and never reached the rule that records the trap — `.claude/rules/ci.md` is injected while you
EDIT, and the question is asked before anything is touched.)
Quality is non-negotiable: all five must pass before a PR.
**Before ANY `git push`: `pnpm ci:local`** — mirrors the FULL GitHub Actions CI (the five commands
above PLUS `pnpm cone` + `pnpm web-imports` + empty-env boot + the self-contained web job + full-history
gitleaks) and stamps `.git/everdict-ci-ok` on a clean green tree; a PreToolUse hook denies unstamped
pushes. `.github/workflows/ci.yml` is the SSOT; see rule `.claude/rules/ci.md` + skill `ci`. **`ci:local` does NOT
cover `trust-fast`** — a required check needing a real Postgres + object store, where a scenario that SKIPS is
a FAILED certification, and skipping is the local default without `EVERDICT_TRUST_DATABASE_URL`. Never push
red; after pushing, confirm the run went green (`gh run watch … --exit-status`).

## The harness's own directories
- `intent/`   — where a change starts: `intent.md` → `spec.md` → `plan.md`, one directory per change. `pnpm intent-chain`.
- `evals/`    — the regression suite over the configuration that steers the AGENT (not the product's scoring domain). `pnpm agent-evals`.
- `releases/` — the authorization a release tag needs before it may leave. `releases/<tag>.md`, committed.
- `REVIEW.md` — the review policy `pnpm review` applies to every push carrying product code.
- `scripts/bands/`, `scripts/telemetry/` — what watches the harness and what collects what files cannot answer.
See rule `.claude/rules/ci.md` for what each refuses and why; `docs/architecture/harness-observability.md` for what it can see about itself.

## The change chain — `intent/` before code
A change whose *why* someone else would have to reconstruct starts as `intent/<YYYY-MM-DD>-<slug>/intent.md`,
gains a `plan.md` **in a later commit**, and closes with `Status: shipped` + `Shipped: <sha>`. `pnpm intent-chain`
asks git for that ordering, because a plan written after the diff reads exactly like one written before it —
the files cannot tell them apart and the commit graph can. See `intent/README.md`. A one-line fix needs none;
the test is whether the reason survives in the commit message alone.

## Architecture — one-way dependency, by concern
```
contracts ← domain ← { application-execution · application-control } ← { drivers · environments · harnesses · graders · llm · trace · db · registry · backends · auth · storage · images · datasets } ← job-runner ← { orchestrator · topology } ← self-hosted-runner ← { apps/cli · apps/desktop }

agent-runtime ← apps/agent          (the reference OWNER runtime — consumes the trust harness, is not part of it)
sdk · otel                          (user-facing surfaces: HTTP client / OTLP door helpers — nothing imports them)
```
The **layer spine** is `contracts ← domain ← application-{execution,control}`: contracts is the pure dependency ROOT (interfaces + Zod schemas + errors), domain adds the pure business kernel (aggregates, version algebra, scoring/suite semantics, authz matrix, policy), and the two application layers hold the use-cases + ports the adapter packages bind. (The former `@everdict/{core,suite,run-case,billing}` packages were folded into this spine in the re-architecture.)
- `packages/contracts`    — contracts (interfaces + Zod schemas + errors + the job-result wire codec) **plus pure/total kernel functions that must cross dependency cones** (`isMeasured`/`sanitizeScore`, `authorizeToolInvocation`/`budgetExhausted`, `effectsRequireConsent`, `metricMatches`/`caseMatches`, `resolvePlacementOs` — decisions lower-cone consumers like `agent-runtime`/`job-runner` execute without a domain dep; admission test: no I/O·no store·total decision·a sub-domain-cone consumer). Dependency ROOT. No I/O, no SDKs. The `@everdict/contracts/wire` subpath is the web's type-only surface.
- `packages/domain`       — the pure business kernel over contracts: the rich aggregates (Run/ScorecardBatch/Membership/Schedule/Issue/Project/Initiative), version algebra (`compareVersions`/`resolveRef`/`specsEqual`), scoring + suite semantics (`caseVerdict`/`summarizeScorecard`/`diffScorecards`/`classifyFailure`/trials), the role→action authz matrix, the eval-tracker progress arithmetic (`projectRollup`/`initiativeReadiness` — the completion gate), and placement policy (FairQueue/CircuitBreaker/Autoscaler/TrustZonePolicy). No I/O.
- `packages/application-execution` — the in-sandbox eval use-cases: `runCase` (the eval loop), `safeGrade`, trace/observation scoring. Depends only on contracts+domain.
- `packages/application-control` — the control-plane use-cases + the ports the adapters bind: `runSuite`, store ports (`RunStore`/`ScorecardStore`/…), registry ports, the `Dispatcher` port, `ArtifactStore` + `offloadSnapshot`, the credential primitives (`generateKey`/`hashKey`/`generateInviteToken`), scheduling/ops orchestration, `Metrics`. Impls live in the adapter packages that depend on it.
- `packages/drivers`      — *in-sandbox compute* (`ComputeHandle`): LocalDriver (dev / inside the agent).
- `packages/environments` — the world a run acts on (`RepoEnvironment`: seed + git-diff snapshot).
- `packages/harnesses`    — the agent under test, driven over a process boundary (ClaudeCodeHarness, ScriptedHarness, + declarative `CommandHarness` — any CLI agent from a `HarnessSpec(command)`, no code. See `docs/command-harness.md`).
- `packages/llm`          — **provider-NATIVE LLM transports** (`LlmTransport`: Anthropic Messages API + OpenAI, native message protocol + prompt/KV caching). everdict deliberately does NOT go provider-agnostic-over-LiteLLM: each provider gets a native transport (`transportFor(provider)`) so we speak its own wire + use its own caching. `stream()` powers the agent loop; `complete()` is the one-shot variant for judges/probes. `openai-compatible` (custom `baseUrl`) is the explicit escape hatch for vLLM / a LiteLLM proxy, never the default. Shared by `agent-runtime` (the agent) + `graders` (judges).
- `packages/graders`      — scoring, fully separate from the harness (tests-pass / cost / steps / latency) + Agent Judge (`JudgeGrader` + `modelJudge` over an injected transport: `transportComplete` [over `@everdict/llm`, provider-native] / `harnessComplete` [dispatch an agent, verdict from its trace] — LLM/VLM/agent verdict from a trace). See `docs/judges.md`.
- `packages/job-runner`        — the dispatched unit: a self-contained worker that runs `runCase` inside an isolated job and emits the result (the backend dispatches it, it does not run the harness itself).
- `packages/backends`     — *placement* (`Backend`): dispatch the agent to an orchestrator (LocalBackend, NomadBackend, K8sBackend [process→K8s Job, `runtimeClassName` isolation]; Windows later) + `Router` (static) / `Scheduler` (capacity-aware + tenant-fair WFQ + queue/backpressure) / `BackendRegistry` + `TrustZonePolicy` (per-tenant isolation: enforced hardened runtime + namespace + warm-pool keying) + `Autoscaler` (queue-depth elastic scaling) + `SecretProvider`/`BudgetTracker` (per-tenant key scoping + cost/run budgets) + `buildRuntimeBackend` (RuntimeSpec→live Backend, for tenant-registered runtimes; control-plane→cluster-API auth via `spec.authSecret`→SecretStore→`X-Nomad-Token`/`kubectl --token`, stripped from alloc env — see `docs/runtimes.md`).
- `packages/orchestrator` — durable control plane on Temporal: `DirectOrchestrator` / `TemporalOrchestrator` + the worker (workflow=deterministic, activity=`dispatchCase`).
- `packages/trace`        — pull a harness trace from the tenant's platform → normalized `TraceEvent`; `buildTraceSource(cfg)` (kind: otel|mlflow|langfuse|langsmith|phoenix) powers pull-mode scorecard ingest. + **outbound `TraceSink`** (`buildTraceSink`: mlflow|langfuse|langsmith|phoenix) — export judged case trace+scores to the tenant's observability platform (create-or-attach per case; MLflow incl. best-effort OTLP/JSON spans, live-verified 3.11/3.14). See `docs/architecture/trace-sink.md`.
- `packages/otel`         — **user-facing OTLP-door helpers** (`@everdict/otel`, dependency-free): `EVERDICT_SEMCONV` + resource/exporter config builders for sending traces TO everdict (`POST /v1/traces`); Python = env-only recipe. See `docs/everdict-otel.md`.
- `packages/topology`     — **service-topology** harnesses (multi-service + target env): `HarnessSpec(service)`, orchestrator-agnostic `ServiceTopologyBackend` + Nomad/K8s topology builders + runId-keyed env manager. See `docs/service-harness.md`.
- `packages/storage`      — object-storage adapters: `ArtifactStore` impls (S3/MinIO presigned + InMemory — run-media offload) + **`WorkspaceFs`** impls (S3WorkspaceFs/InMemoryWorkspaceFs) — the **workspace filesystem**: one isolated file tree per workspace with **one MinIO/S3 BUCKET per tenant** (`fsBucketFor` collision-proof naming, lazy create; the bucket is the isolation boundary) + traversal-rejecting path guard INSIDE the adapter; agents write task outputs to it (list_files/get_file/write_file… MCP tools, `/fs` routes, web `/files` tree+shell) with per-task separation (`tasks/<conversation-id>/` via the agent env block), and it holds skill/knowledge bodies as the SSOT (`skills/<id>/SKILL.md`, `knowledge/<id>.md` — content-projection: save=fs-first, get=fs-first + lazy DB-replica re-sync). **Every write publishes an attributed REVISION** (`RevisionedWorkspaceFs` decorator, wired once in `main.ts`): the ledger (`FsRevisionStore`→Pg/InMemory, mig 0089) records who published it — member **or agent** (agent id + conversation + the member it acted for) — while the bytes go to the tenant's sibling revision bucket; a write declaring `baseRevision` that lost the race is refused with a 409 carrying the live content + a three-way merge (`mergeThreeWay` in `@everdict/domain`), so members and agents editing one file never silently overwrite each other. See `docs/architecture/workspace-filesystem.md`.
- `packages/db`           — result stores: `RunStore` (single runs) + `ScorecardStore` (batch eval = dataset×harness → aggregated `Scorecard`+summary; `list` omits heavy per-case results) + `ViewStore` (saved scorecard-analysis views — config `jsonb`, `private|workspace` visibility) + the eval-tracker stores (`IssueStore`/`ProjectStore`/`InitiativeStore`, facts on the E0 same-tx outbox) — `InMemory*` / `Pg*` on Postgres + numbered SQL migrations + idempotent `migrate`/`preflight`. See `docs/migration/` + `docs/scorecards.md` + `docs/tracker.md`.
- `packages/registry`     — **versioned SSOT** (harnesses + datasets + judges + runtimes): `(tenant, id, version) → HarnessSpec` / `→ Dataset` / `→ JudgeSpec` / `→ RuntimeSpec` (immutable versions, semver `latest`, tenant-owned + `_shared` fallback; in-memory / file-GitOps / Postgres `Pg*Registry` — async interface); `ServiceTopologyBackend.specFor` wires to the harness registry. Datasets are **harness-agnostic**; **Agent Judges** are user-registered `model`|`harness` specs; **Runtimes** are user-registered execution infra (local|nomad|k8s; `local` = dev/control-plane-host, superseded for "my machine" by the self-hosted runner). See `docs/registry.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md`.
- `packages/auth`         — **control-plane auth core**: `Authenticator` → `Principal{subject,workspace,roles,via}` (OIDC/Keycloak JWT via `jose` JWKS + API-key `ak_…`, `compositeAuthenticator`) + role→action authZ (`can`/`authorize`). `workspace=tenant=trust-zone`. See `docs/auth.md`.
- `packages/datasets`     — **task-format on-ramps**: a Terminal-Bench task set (instruction + prebuilt image + `tests/` verifier) → `EvalCase[]`, plus benchmark adapters and `CaseMapping` rules for HF/jsonl/csv. Everdict REFERENCES images, it never builds them (`resolveImage` throws). A task's `tests/` bytes and verifier env are VERIFIER-PRIVATE — see rule `protocol` and `verifierPlanOf`. See `docs/datasets.md` + `docs/architecture/standard-task-formats.md`.
- `packages/images`       — adapters behind the `WorkspaceImages` port (managed image store): copy/mirror, provenance, in-memory + registry clients. A registry client is not object storage, which is why it is not in `storage`. See `docs/architecture/managed-image-store.md`.
- `packages/agent-runtime` — **the agent kernel**: a domain-agnostic, Claude-Code-style agentic loop (turns over a `ToolRegistry`, ToolSearch progressive disclosure, context compaction, sub-agents, MCP bridging, the envelope + consent gates). Reinterpreted from digo-agent's runtime kernel. Transport-injected — it does not know Everdict. See skill `agent-runtime`.
- `packages/sdk`          — the **one-call developer surface** over the control-plane HTTP API (`@everdict/sdk`). A pure HTTP client of the public routes with type-only contract imports; nothing in the monorepo depends on it. See `docs/architecture/one-call-sdk.md`.
- `packages/self-hosted-runner`  — **self-hosted runner core** shared by CLI + desktop: MCP lease loop (`runLeaseWorkers`), resilient session (`ResilientMcpSession`), harness-kind branch execution (`runLeasedJob`: service→Docker topology / else→`runCaseJob`). GUI-free, transport-injectable. See `docs/architecture/desktop-app.md` + `docs/architecture/self-hosted-runner.md`.
- `apps/agent`            — **Everdict's own agent**, the reference owner runtime over `@everdict/agent-runtime`: workspace conversations, the tool surface (fs · code · runs · evals · integrations · skills · knowledge), activation/triggers, HITL approval, memory. It CONSUMES the trust harness and is not part of it (see the trust gate below).
- `apps/cli`              — dev/single-run control plane (`everdict run [--orchestrator temporal]`, `everdict worker`) + `everdict runner` (thin wrapper over `@everdict/self-hosted-runner`).
- `apps/api`              — **multi-tenant control-plane HTTP surface** (Fastify): owns auth (`@everdict/auth`: OIDC + API keys → `Principal`, role-gated routes, `GET /me`), tenant-owned harnesses (`POST/GET /harnesses`), tenant-owned + `_shared` datasets (`POST/GET /datasets`, harness-agnostic eval-case bundles), user-registered + `_shared` Agent Judges (`POST/GET /judges`, `model`(LLM/VLM call) | `harness`(delegate)), user-registered + `_shared` Runtimes (`POST/GET /runtimes`, local|nomad|k8s execution infra; `RuntimeDispatcher` routes a tenant's run to its chosen runtime), async batch evals (`POST/GET /scorecards`, dataset×harness → aggregated `Scorecard`+summary via `runSuite`, + selected judges applied to each trace → `judge:<id>` scores; model judges call the provider with the tenant's SecretStore key; `GET /scorecards/diff` = baseline↔candidate regressions/improvements; `POST /scorecards/ingest` = score externally-run `TraceEvent[]` with no harness run [push]; `POST /scorecards/ingest/pull` = pull traces from a tenant's OTel/MLflow [MLflow 3.x `/api/3.0/.../traces/get`, OTLP spans] via `@everdict/trace` `buildTraceSource` [`source.authSecret`→SecretStore value→verbatim `Authorization` header: `Bearer …`/`Basic …`] then score [pull; live-verified vs MLflow 3.11.1]), the **eval tracker** (`/issues` · `/projects` · `/initiatives` — Linear-shaped Initiative ⊃ Project ⊃ Issue, the "why we evaluate" layer over the primitives: an issue links the harnesses/datasets/judges/scorecards that verify it, closes with a `resolution` naming the scorecard that proved it, and reopens as `regressed` when that resolution stops holding; an **initiative is a GOAL** several projects work toward (not a release train) — its progress is live arithmetic over every issue underneath, its `lead`+`health` come from its own posted-update timeline (`POST/GET /initiatives/:id/updates`, same shape projects have), and completing a project/initiative is a GATE refusing while issues are open, `force` recorded; one action pair `issues:read`/`issues:write`; facts `issue.created`/`issue.status_changed`/… on the E0 outbox, durable per-record `history[]` because the log is swept — see `docs/tracker.md`), the **product timeline** (`/products` · `/releases` — Product = the shipped thing's real service composition [GitHub releases/tags pulled into an insert-once version ledger, no webhook] + watch series [dataset×harness×judges, auto-evaluated on genuinely new versions with origin `{source:"product", productId, seriesKey, serviceVersion}` as the trend's x-axis key]; Release = a gated checkpoint refusing to ship over open linked issues or a series regressed vs the previous ship, `force` recorded; `GET /products/:id/timeline` = the axis in one read — see `docs/architecture/product-timeline.md`), saved scorecard-analysis **Views** (`POST/GET/PATCH/DELETE /views` — `private|workspace` saved lenses over `listScorecards`, re-run live on open; edit/delete = creator or admin; authz **reuses** `scorecards:read`/`scorecards:run`, no new action), **Subscriptions** (`POST/GET/PATCH/DELETE /subscriptions` — the E3 registry: selector [trigger-matchable kinds + payload filters, shared grammar with agent triggers via `@everdict/domain` `eventSelectorMatches`] → reaction [agent = activation engine | webhook = signed E1-cursor delivery | workflow = durable T-d `reaction:<eventId>:<subId>` agent chain on Temporal] under governance [enabled·cooldownSec]; authz **reuses** `agents:read`/`agents:write`; edit/delete = creator or admin — see `docs/architecture/event-plumbing.md` §6), **workspace GitHub App integration** (`GET/POST/DELETE /workspace/github-app*` — org install→selected repos→**workspace-owned** installation tokens that GitHub scopes to the chosen repos; used for private clone/CI setup-PR/runner registration; github.com App via operator env, GHE App workspace-registered [host+App ID+private-key SecretStore ref]; `settings:write`) + **workspace Mattermost** (`GET/PUT/DELETE /workspace/mattermost` — bot-token completion/regression channel notifications, self-serve admin registration) + **workspace trace sources** (the ONE observability-platform registration pool `GET/PUT /workspace/trace-sources` + `DELETE …/:name` + `POST …/probe` [connect→scope-discovery, settings:write]; a harness uses a source to PULL its trace from `PUT /harnesses/:id/trace-source` and/or to EXPORT judged detail to `PUT /harnesses/:id/trace-sink` [both member+, opt-in — the "sink" is a trace source used as an export target, otel excluded]; mlflow/phoenix require a scope [experiment/project] at register time; export outcome on `ScorecardRecord.export` [status/link/per-case external id, mig 0048], failure never fails the scorecard; pull-ingest with matching source kind **attaches scores to the original traces** instead of duplicating; browse + inspect [`…/:name/traces`, `…/traces/:id/inspect` → structured span waterfall] powers Settings › Observability — see `docs/architecture/trace-sink.md`) + **workspace image registries (multiple)** (`GET/PUT /workspace/image-registries` + `DELETE …/:name` + `POST …/push-credentials?name=` [name required if multiple] — BYO registries as the image-provenance baseline: `classifyImageRef` 4-class [workspace/external/local/unqualified], harness register/validate `imageWarnings`, member-gated push-credential mint [`images:push`] consumed by `everdict image push` — see `docs/architecture/workspace-image-registry.md`), **CI triggers (GitHub Actions)** (PR = submit-time ephemeral `harness.pins` image swap recorded in `ScorecardRecord.origin.pinOverrides`; PR comment `/evaluate` = on-demand re-evaluation[issue_comment, collaborator gate+PR head checkout+reply in thread; link `trigger` auto|comment|both]; merge = `POST /harnesses/:id/pins` headless re-pin → new immutable instance version; repo links `GET/PUT/DELETE /workspace/ci/links` [link = OIDC trust policy] + `GET /workspace/github-app/repos` picker + `POST /workspace/ci/links/setup-pr` workflow generator; keyless auth via GitHub Actions OIDC federation → `ci` role — see `docs/architecture/github-actions-trigger.md`), `POST /internal/tenant-keys` ({workspace}), async `POST /runs`→run-id + workspace-scoped reads, `RunStore`/`ScorecardStore` (in-memory or Postgres via `DATABASE_URL`), and the agent-facing **MCP server** (`/mcp`, Streamable HTTP, OAuth-protected via Keycloak "login like Linear" + API keys, role-gated tools — full BFF↔MCP parity for runs/harnesses/datasets/judges/runtimes/scorecards/views/subscriptions/issues+projects+initiatives/github-app/mattermost). See `docs/api.md` + `docs/auth.md` + `docs/mcp.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md` + `docs/scorecards.md` + `docs/architecture/scorecard-analysis-views.md` + `docs/architecture/workspace-scoped-integrations.md` + `docs/tenancy.md`.
- `apps/web`              — **SaaS web** (Next.js 16 App Router, FSD, Tailwind v4 + shadcn Toss-style): Keycloak (Auth.js) user login; a **token courier** — forwards the Keycloak access token as `Bearer` to the control plane and gets `workspace`/roles from `GET /me` (role-gated UI; control plane enforces). The home screen is the **workspace pulse** (state tiles + trend charts + the all-axis activity feed, one aggregate read `GET /workspace/pulse` — not an eval dashboard: a workspace also files issues, runs iterations, chases goals and keeps agents working). Per-workspace dashboard (runs/harnesses/datasets/judges/runtimes/scorecards/views + the eval tracker: issues/projects/initiatives) + workspace Settings (secrets · members · integrations[GitHub App·Mattermost]) + personal **account** page (profile · personal secrets · API keys). Self-contained eslint+prettier (excluded from root Biome). Pure HTTP client of the control plane; runtime-decoupled — the only allowed `@everdict` dep is TYPE-ONLY `@everdict/contracts` (wire/record types, re-architecture P4; local zod v4 schemas keep runtime validation, drift-guarded against the contract types). See `docs/web.md` + `docs/auth.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md` + `docs/scorecards.md` + `docs/architecture/workspace-pulse.md` + `docs/architecture/workspace-scoped-integrations.md`. (Humans→Keycloak; agents→API keys/MCP.)
- `apps/desktop`          — **Electron desktop shell**: renders the *deployed* `apps/web` in a BrowserWindow (full web parity by construction — zero UI re-implementation; desktop-aware UI = `window.everdictDesktop`-conditional branches inside `apps/web`) + resident self-hosted runner (`@everdict/self-hosted-runner` in the main process, one-click pairing via an origin-gated preload bridge, `rnr_` token in `safeStorage`). Tray-resident (close = hide). Security invariants + conventions: `.claude/skills/desktop/SKILL.md`. See `docs/architecture/desktop-app.md`.
Reverse imports are bugs. The same concern name recurs per package (vertical slices).

**Intra-package layout:** a package's `src/` stays flat until ~15 non-test files; beyond that, group into
**domain** subdirectories (tests colocated) with the barrel `index.ts` + the package's core contract kept at the
root. The barrel re-exports the same symbols, so grouping never changes the public surface (consumers are untouched).
See `packages/backends` (`placement`/`orchestrators`/`scheduling`/`policy`), `contracts` (`execution`/`harness`/`infra`/`records`),
`trace` (`sources`/`sinks`); `apps/web` (FSD) is the reference for large apps. Small packages stay flat by design.

### Two execution layers: Backend (placement) vs Driver (in-sandbox)
- **Backend** (`@everdict/backends`) = *placement*: dispatch a job-runner job to an orchestrator
  (Nomad/K8s/Windows) and return the `CaseResult`. Isolation = the orchestrator's runtime.
- **Driver** (`@everdict/contracts`/`drivers`) = *in-sandbox compute*: the agent runs the harness via
  `LocalDriver` inside its already-isolated job. See `docs/execution-backends.md`.

### ⚠️ Deliberate deviation: interfaces ARE used
Single-implementation codebases rightly ban interfaces for DI (exactly one impl per concept).
Everdict's *whole product* is pluggable adapters (many Backends / Drivers / Harnesses / Graders), so the
`@everdict/contracts` contracts MUST be interfaces. This is the one idiom we intentionally invert —
everywhere else (null discipline, error model, naming, layering) we keep the strict default.

## 🔒 The protocol laws — read `.claude/rules/protocol.md` + skill `protocol` BEFORE designing an effect path
Everdict sells a *defensible verdict*, so the seam between a decision and an effect is the product. Fifty-three
architecture reviews found the same defect class there, and never because a concept was missing: the right
noun existed and was then consumed as an **annotation** — optional, swallowed, re-derived, or advisory exactly
where the next effect begins. The five laws, in full with case law, in skill `protocol`:
1. **Authority before effect** — no external effect until a store RETURNED proof the identity is durable. An
   optional pre-effect hook is a request; a required proof parameter is a protocol. Writes a decision rests on
   never return `Promise<void>`.
2. **Unknown is unignorable** — a failed read is a third value (`ReadResult`), consumed by exhaustive match.
   Never `.catch(() => [])`, never `{value?, ok: boolean}`. An allowlisted scanner entry is a design admission.
3. **Provenance is born at the source** — never re-derive identity from rendered output (metric name → judge,
   latest row → winner, timestamp → attempt). A predicate written twice has already diverged.
4. **A settlement owns immutable bytes** — decisions reference frozen payloads by key+digest; `current` is a
   monotonic projection; an at-least-once effect's idempotency key lives in the PUBLIC contract.
5. **Completion is verified zero** — accepted ≠ gone. One verifier shared by the request path and the
   reconciler; "cannot find out" is an escalation field, never a terminal state.

**Definition of done for a protocol change**: counterexample seen RED *for the stated reason* → the change →
`pnpm protocol-mutations --only <rung>` red under neutralization (author-run; no longer a gate) → **the escape hatch deleted in the same change**. A test
that stays green after its subject is deleted is a lost test (rule `testing`, vacuous-pass rules).

## Critical rules (the non-default ones — see `.claude/rules/`)
- No `any`, no non-null `!`, no silent nullable defaults; validate every boundary with Zod.
- Errors: throw an `AppError` subclass (`@everdict/contracts`); HTTP status derives from the subtype.
- External/SDK failures are remapped to our `AppError` (never propagated raw) so monitoring blames us, not the user.
- Cost/tokens come from the harness's own trace (e.g. Claude reports `total_cost_usd`); for LocalDriver the harness uses the machine's existing login (no API key).
- `ComputeHandle` is always released in a `finally`.
- Backends never run the harness; they dispatch the `@everdict/job-runner` image and parse its `__EVERDICT_RESULT__` stdout sentinel.
- Temporal workflow code (`@everdict/orchestrator` `workflows.ts`) MUST be deterministic — no I/O; side effects go in activities.

## Key principles
1. **Read first, code second — NO EXCEPTIONS.**
2. **Quality is non-negotiable** — format/lint/typecheck/test/build all green.
3. **Skills travel with the code** — a PR that changes a convention/invariant updates the matching skill reference *in the same PR* (mere implementation churn is not a doc trigger).
4. **Reinterpret, don't copy** — proven idioms from prior codebases are adapted to TS, not transplanted verbatim; note the source idea when non-obvious.
5. **New top-level domains pass the trust gate** — a new domain enters the spine only if it strengthens the
   trust harness (execution→evidence→measurement→verdict→regression→reproduction) or the owner protocol;
   otherwise it ships as an application/plugin on top. The agent runtime is a *reference owner runtime that
   consumes the trust harness* — not the product identity; complexity budget is measured in invariant upkeep,
   not feature count.

## Commits
Conventional Commits, scoped: `feat(drivers): ...`, `fix(runner): ...`. Body explains the *why*.
Every `fix:` ships a regression test that fails on the pre-fix code.
