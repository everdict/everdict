# Everdict re-architecture — the domain is unique, interfaces are adapters (design)

> **Status: APPROVED (2026-07-10, maintainer) — migration in progress. Constraint: behavior-preserving
> at every phase (compat re-exports, wire bytes unchanged, full gates + boot green per commit).**
> Open questions resolved: §8-1 two packages (proposed, adopted) · §8-2 wire v1 namespace deferred ·
> §8-3 self-hosted-runner stays its own package (proposed, adopted) · §8-4 existing scope names kept until the P4 sweep.
>
> **Progress:** P0 SHIPPED (`764ba6a`·`fcdbc1f`·`de95544` — @everdict/contracts [core verbatim + sentinel
> codec + records + wire DTOs] + agent-cone CI guard). P1 SHIPPED (`16f6b17`→`21be477` — @everdict/domain:
> suite semantics · auth matrix + billing · 4 aggregates · placement policies · kernel rules out of
> contracts [cone invariant: domain deps == {contracts}] · registry version algebra · served computed
> fields [scorecard verdict/casePass/headline · harness imageClasses · github-app installedAccounts] with
> the web caseVerdict/classifyImageRef/sameHost mirrors and the SDK headline mirror DELETED).
> P2 SHIPPED (`e5feb5f`→`c0c3289` — @everdict/application-execution [runCase + safeGrade +
> scoreObservations; topology adapters stop scoring; cone deps == {contracts, domain}] +
> @everdict/application-control [runSuite · 16 store + 7 registry + Dispatcher/JudgeRunner/ExecStream/
> ArtifactStore ports · 4 outbound gateways (Mattermost, GithubRepoWriter, GithubAppGateway, TraceSink/
> TraceSource contracts → contracts) · every movable core service + ops + the scorecard cluster +
> executeCase/collect/scoring — forbidden values become injected factories (makeGraders,
> defaultTraceGraders)] · apps/api/src/core = adapters + compat shells only · main.ts = 276-line
> composition root over apps/api/src/composition/ (ScheduleServiceRef makes the schedule cycle explicit)
> · CLI composes application-control/domain directly).
> P3 SHIPPED (`7ceb7b4`·`07d7417` — golden contract tests first [registry 78→247 tests: capability
> matrix incl. ABSENCES, non-semver registration-order rule, ownerOf divergence, Pg deleted_at/
> specsEqual pins; mutation-verified], then the 12× dedupe: all six hand-rolled registries delegate to
> the generic VersionedStore/PgVersionedStore via a capability-flag config that gates SQL by omission
> [byte-identical queries], −797 LOC; PgDataset list/summarize stays local by design [fused query].
> Compute-adapter policy extraction + persistence consolidation were already satisfied by P1/P2 +
> construction; per §8-4 no package renames before the P4 sweep. Layer pin (6) added to the cone guard:
> application-control deps == {application-execution, contracts, domain, zod}).
> P4 IN PROGRESS (`80a67c3`·`673a3c2`·`ee677b1` — web wire-type adoption COMPLETE: all 26 entity
> mirrors anchor to contracts via type-only imports + compile-time drift guards [bidirectional /
> Pick-reverse / run-style split; zod v3/v4 coexist — z.unknown() and z.default() optionality quirks
> pinned; spec discriminated unions stay honest local views]; 138 wire type exports; enforcement live:
> check-web-imports.mjs [type-only, contracts-only] + the four layer pins in check-agent-cone.mjs.
> REMAINING P4, deliberately deferred: ① the compat-shell sweep (rewrite all imports to the new
> packages, delete shells) NEEDS A COORDINATION WINDOW — the shared working tree may hold concurrent
> WIP importing the shells (§7 risk); ② blanket interface-kit mappers on all 154 operations judged
> lower-value than the plan assumed — routes already return the wire shapes (P0 typed identity) and
> parity is structural (one service, two transports); the serveScorecard precedent shows mappers should
> land opportunistically where a response needs server-side derivation, not as churn-only pass-throughs;
> ③ CLI output DTOs (dev tool, low value). Maintainer call requested on ①'s timing and ②'s posture.
> Maintainer directive: interfaces (CLI / web / API / desktop) are delivery mechanisms; the domain is
> singular. Today domain rules are fragmented across packages and re-implemented inside interfaces. This
> document is the ground-up target: layer model, package/folder teardown, port design, DTO boundaries,
> migration plan. Companion: `domains/<domain>.md` — one collaboration model + diagram per domain, for
> one-by-one review.

## 1. Context and constraints

Everdict ships **four deployables from one monorepo**, and any architecture must serve all four:

| Deployable | What runs | Constraint |
|---|---|---|
| **Agent image** | the in-job worker executing one case (`runCase`) | dependency cone must stay slim; no Postgres/pg, no control-plane SDKs; today 327MB slim image |
| **Control plane** (`apps/api`) | multi-tenant HTTP+MCP surface, batch orchestration, Temporal | durable, multi-process future; today largely single-process in-memory state |
| **CLI** (`apps/cli`) | embedded engine (run/worker/suite compose the engine in-process) + control-plane client (runner, image push) | must compose the SAME use-cases as the API, not parallel re-implementations |
| **Web / Desktop** | pure-HTTP UI / Electron shell + resident runner | web imports zero `@everdict/*` by design — the posture to KEEP and extend |

Non-negotiables carried forward: one-way dependency DAG, Zod-validated boundaries, `AppError` model,
BFF↔MCP parity, English-only public artifacts, store-atomic invariants stay with SQL.

## 2. What the survey found (evidence the design must answer)

Full inventories: `tmp/survey/{engine-execution, placement-orchestration, data-infra, apps-api,
interfaces}.md`. The findings that force a redesign:

1. **Domain rules are re-implemented, not shared.** Case-verdict authority ranking exists **3×**
   (`@everdict/suite` original, `apps/web` UI mirror, `packages/sdk` mirror). Run-submission recipe
   (default graders/timeout) **3×** (CLI `buildJob`, web `submitRunAction`, MCP). GitHub host
   normalization **3×** (the past `748eecb` production bug was exactly one copy drifting). Screenshot
   materialization **3×**; scoring executes in **3 places** (run-case, topology's second eval loop inside a
   *placement adapter*, control-plane judge pass); failure-CaseResult synthesis, OOM classification,
   trace-platform coordinates (**5 shapes**), capability vocabulary (**2**) — all multi-homed.
2. **A real domain kernel already exists but has no home.** `@everdict/core` mixes contracts with an
   unnamed pure-domain kernel (`classifyFailure`, `resolveHarnessInstance`, `classifyImageRef`, capability
   model); `@everdict/backends` hides pure policy gems (WFQ FairQueue, admission/backpressure/aging,
   CircuitBreaker, Autoscaler, TrustZonePolicy) inside an infra package; `@everdict/suite` is the purest
   domain code in the repo (verdict/pass@k/z-test/leaderboard) fused with batch-driving application code;
   `@everdict/registry` implements the same immutability/tombstone/`_shared` invariants **12×**
   (6 entities × 2 backends); `@everdict/billing` is clean but `apps/api/src/common` re-implements its
   persistence composition. Rounds 2–6 built 4 rich aggregates (Run, ScorecardBatch, MembershipPolicy,
   Schedule) — inside `apps/api`, reachable by no other deployable.
3. **No explicit application layer.** ~162 control-plane use-cases live across services, free functions,
   route closures, and **35 lambda ports closed over in a 1,374-line `main.ts`**; `ServerDeps` is a
   40-optional-field grab-bag duplicated as `McpDeps`. The CLI embedded mode hand-composes a *parallel*
   application layer (judge-less `suite`, store-less `run`).
4. **Interfaces leak the domain.** HTTP/MCP ship raw store records (Round 5 response schemas are
   doc-only); the CLI prints raw domain JSON; the web re-implements domain logic client-side because the
   wire carries no derived fields; the sdk hand-mirrors DTOs. There is **no owned wire contract**.
5. **Contracts are trapped in fat packages.** The result-sentinel codec lives in the heaviest package
   (`agent`) so backends/runner inherit the full engine cone for `parseResult`; `CommandHarness`
   value-imports `@everdict/trace` into the agent image; `@everdict/auth`'s ports are owned by `db`.

## 3. Principles (the consistent core of clean/hexagonal, applied)

1. **Dependency rule** — source dependencies point inward only:
   `contracts ← domain ← application ← infrastructure ← interface`. Nothing inner knows anything outer.
2. **The domain is unique.** Every business rule has exactly one implementation, in `@everdict/domain`.
   A rule needed by an interface is *served* to it (computed field on the wire), never re-implemented.
   The two sanctioned non-homes: **store-atomic invariants** (SQL CTEs/`FOR UPDATE` — the store IS the
   home; domain declares the semantics, contract tests pin them) and **pure wire contracts** (shapes are
   contracts, not rules).
3. **Ports and adapters.** The application layer owns its port interfaces (stores, dispatch, notify,
   export, clock/id). Adapters implement ports; adapters never define policy. Where an adapter needs a
   business decision (OOM classification, adopt outcome), it calls a domain function.
4. **Interfaces speak DTO.** Every interface maps domain/application output through an owned wire
   contract (`XResponse.from(...)`). Derived values the UI needs (verdict, pass-rate headline, image
   class) are computed server-side into the DTO — that is what deletes the web/sdk logic mirrors.
5. **One use-case, N drivers.** A use-case is written once in the application layer and composed by the
   control plane (hosted), the CLI (embedded), and the agent (job-side) alike.

## 4. Target structure (full teardown)

```
packages/
  contracts/                     # L0 — zero-dep: types, Zod schemas, AppError, ErrorCode
    src/{eval-case, case-result, trace-event, harness-spec, runtime-spec, judge, dataset,
         agent-job,              # SLIMMED: job essentials; scheduling/billing hints move to a
                                 #  control-plane envelope type (the god-DTO split)
         job-result-wire,        # the __EVERDICT_RESULT__ sentinel codec (from packages/agent)
         wire/**}                # the public wire DTOs (control-plane responses) — THE contract
                                 #  web/sdk import types from here; no more hand mirrors
  domain/                        # L1 — THE unique domain. Pure. Imports contracts only.
    src/run/                     # Run aggregate (from apps/api core/run)
        scorecard/               # ScorecardBatch aggregate + verdict authority + pass@k + trials +
                                 #  diff/regression z-test + leaderboard/trend (from suite) + subset/
                                 #  grading-plan/origin helpers (from api scorecard-shared)
        harness/                 # resolution semantics + visibility policy + pin identity
                                 #  (from core/harness, api harness-service, topology image-pin)
        dataset/                 # diff semantics + row→case mapping rules (from datasets pure half)
        judge/                   # judge/rubric/model semantics + judge composition rules
        runtime/                 # capability model + placement gates (from core + backends policy)
        placement/               # FairQueue/WFQ, admission (quota/backpressure/aging), CircuitBreaker,
                                 #  Autoscaler, TrustZonePolicy (from backends — pure policy)
        failure/                 # classifyFailure taxonomy + OOM rules (from core; single owner)
        member/ schedule/ runner/  # MembershipPolicy·Schedule·RunnerLease state machine
        comment/ billing/        # threading rules · payer/budget/usage rules (billing absorbs the
                                 #  api/common re-implementation)
        image/ trace/            # classifyImageRef + host normalization · ONE trace-coordinates model
        auth/                    # role/scope matrix (authz.ts from packages/auth)
  application/
    execution/                   # L2a — agent-safe use-cases: runCase two-phase loop + scoring
                                 #  composition + collect (absorbs run-case; the topology grading loop
                                 #  collapses into THIS — placement adapters stop scoring)
    control/                     # L2b — control-plane use-cases (~162, from apps/api services) +
                                 #  runSuite batch driving (from suite) + Temporal workflow contracts
                                 #  (from orchestrator) + PORTS: Store interfaces (from db), Dispatcher,
                                 #  registries, notifier, exporter, secret, clock/id — typed port bag
                                 #  replaces the 40-field ServerDeps/McpDeps grab-bag and main.ts's 35
                                 #  lambda closures
  infrastructure/
    persistence-pg/              # Pg stores + migrations + generic VersionedStore (registry invariants
                                 #  ×12 → 1 generic impl + per-entity config); InMemory* stays for tests
    compute/                     # drivers + environments + harness ADAPTERS (Claude/命令 exec plumbing;
                                 #  their embedded billing/trace policy moves to domain/application)
    placement-{local,nomad,k8s}/ # backends adapters (policy extracted to domain/placement)
    temporal/                    # orchestrator's Temporal client/worker adapter
    topology-runtimes/           # service-topology runtimes (builders stay; the eval loop leaves)
    trace-adapters/              # 5 sources + 4 sinks (semantics/coordinates in domain/trace)
    identity/                    # keycloak/jwks/api-key/gh-oidc authenticator adapters (from auth)
    integrations/                # github-app / mattermost / HF / S3 clients (from api infrastructure/,
                                 #  storage, datasets' fetch adapters)
  interface-kit/                 # L3-shared — DTO mappers: XResponse.from(domain) for every wire DTO in
                                 #  contracts/wire; HTTP routes and MCP tools consume the SAME mapper
apps/                            # L3 — interfaces + composition roots ONLY
  api/                           # routes/tools/docs + composition (main.ts shrinks to wiring builders
                                 #  over application-control ports)
  agent/                         # job-side composition of application/execution (from packages/agent)
  cli/                           # commands = thin drivers over application use-cases (embedded mode
                                 #  composes the same use-cases; output through interface-kit DTOs)
  desktop/ web/                  # unchanged posture (web additionally imports contracts/wire TYPES,
                                 #  deleting its 26 hand mirrors + 3 logic mirrors via served fields)
```

**Old → new mapping (every current package):**

| Current | Destination |
|---|---|
| `core` | split: `contracts` (schemas/types/errors) + `domain/{failure,harness,image,runtime}` (kernel) + adapter strays → `infrastructure/*` |
| `suite` | split: `domain/scorecard` (verdict/trials/diff/leaderboard) + `application/control` (runSuite) |
| `run-case` | `application/execution` |
| `agent` | `apps/agent` (composition) + `contracts/job-result-wire` (sentinel) |
| `backends` | `domain/placement` (policies) + `application/control` (Dispatcher port) + `infrastructure/placement-*` (adapters) |
| `orchestrator` | `application/control` (workflows/activities contract) + `infrastructure/temporal` |
| `topology` | `domain/harness` (pin identity) + `domain/trace` (coordinates) + `infrastructure/topology-runtimes`; its eval loop merges into `application/execution` |
| `db` | `application/control` (store PORT interfaces) + `infrastructure/persistence-pg` (Pg impls + migrations + InMemory test doubles); record schemas → `contracts` |
| `registry` | `domain` (version algebra `specsEqual`/`resolveRef`) + `infrastructure/persistence-pg` (generic VersionedStore ×1) |
| `auth` | `domain/auth` (matrix) + `infrastructure/identity` (authenticators); ports repatriated to application |
| `billing` | `domain/billing` (+ absorbs `apps/api/src/common/{budget-tracker,usage-meter}` persistence composition as application ports) |
| `trace` | `domain/trace` (semantics) + `infrastructure/trace-adapters` |
| `datasets` | `domain/dataset` (mapping/diff rules) + `infrastructure/integrations` (HF/format fetchers) |
| `drivers`, `environments`, `harnesses` | `infrastructure/compute` (billing/trace policy extracted) |
| `storage` | `infrastructure/integrations` (S3/artifact adapter; presigned-URL persistence bug fixed in passing) |
| `self-hosted-runner` | stays a deployable-support package: `application/execution` consumer + `infrastructure` MCP-session adapter (internal split) |
| `sdk` | regenerated over `contracts/wire` types (mirrors deleted) |
| `apps/api/src/core` | services → `application/control`; models → `domain/*`; `infrastructure/oauth` → `infrastructure/integrations` |

**Agent-image cone check** (the hard constraint): `apps/agent → application/execution → domain →
contracts` (+`infrastructure/compute`, `trace-adapters`). No `persistence-pg`, no `identity`, no
`interface-kit`. The sentinel codec moving into `contracts` frees backends/runner from today's inverted
dependency on the whole engine.

## 5. Interface exposure — how upper modules are designed

- **Inbound**: each domain's use-cases are typed application services (`SubmitRun`, `RunScorecardBatch`,
  `PairRunner`, …) with command-object inputs. HTTP routes, MCP tools, and CLI commands are ≤10-line
  drivers: parse (request DTO) → call use-case → map (response DTO). The 6-step handler shape survives;
  step ⑤ changes from "return service result verbatim" to "return `XResponse.from(result)`".
- **Outbound**: application owns port interfaces; composition roots (`apps/*/main`) bind adapters. The
  port bag is per-domain and typed (no 40-field optional grab-bag) — a use-case declares exactly the
  ports it needs.
- **Wire contract**: `contracts/wire` is the single public shape vocabulary. Response DTOs carry
  server-computed derivations (verdict, headline pass-rate, image class, host-normalized display) so no
  client re-implements a rule. Web/sdk import these types; ko/en display stays client-side.
- **Parity**: interface-kit mappers are the parity mechanism — HTTP and MCP cannot drift because both
  call the same `from()`.

## 6. Migration plan (strangler, every phase green: workspace typecheck + full tests + boot + agent image build)

- **P0 — contracts + sentinel + wire types.** Split `contracts` out of core; move the sentinel codec;
  introduce `contracts/wire` (typed from Round 5's response schemas). Compat re-exports everywhere.
- **P1 — domain consolidation.** Create `@everdict/domain`; move the 4 aggregates + suite semantics +
  backends policies + kernel functions + billing/auth matrices; delete the web/sdk logic mirrors by
  serving computed fields. (Absorbs the approved Round 7 plan.)
- **P2 — application layer.** `application/execution` (run-case + topology loop merge) and
  `application/control` (api services move; ports extracted from db; ServerDeps→typed port bags;
  main.ts→pure composition). CLI embedded mode rewires to the shared use-cases.
- **P3 — infrastructure regroup.** Adapter moves (mechanical), registry VersionedStore dedupe,
  persistence-pg consolidation.
- **P4 — interface hardening.** interface-kit mappers live on every route/tool; CLI output DTOs; web
  imports wire types (deletes 26 mirrors); enforcement lands: dependency-cruiser CI gate encoding §3-1,
  agent-cone allowlist, "no `@everdict/domain` import in apps/web" checks.

Each phase is independently shippable; P0/P1 unblock the highest-value duplication deletions first.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Big-bang import churn breaking teammates' WIP | phase-per-commit, compat re-exports until the sweep commit of each phase; coordinate windows |
| Wire-shape regressions while introducing DTO mappers | P0 mappers are typed identity (wire bytes unchanged, pinned by the 706-test suite + web build); field tightening is explicitly later, per-domain |
| Agent image bloat via accidental cone edges | CI cone check from P0 (fail on new edges), image-size budget assertion |
| Temporal determinism (workflows move packages) | workflow code moves verbatim; replay tests before/after |
| The 12× registry invariant dedupe changing subtle per-entity behavior | golden contract tests per entity before the generic swap |

## 8. Open questions for review

1. Package granularity: `application/{execution,control}` as two packages (proposed) vs one with two
   entrypoints — two keeps the agent cone provable by construction.
2. `contracts/wire` versioning: adopt a `v1` namespace now (future-proof external SDK) or defer?
3. `self-hosted-runner` placement: keep as its own package (proposed — it is a deployable library used
   by CLI+desktop) vs fold into `application/execution`.
4. Do we rename npm scopes (`@everdict/contracts` etc.) in P0 or keep old names as aliases until P4?

## 9. Domain collaboration models

Per-domain diagrams + collaboration walkthroughs for one-by-one review: `domains/<domain>.md` —
run · scorecard · harness · dataset · judge(+rubric/model) · runtime(+capability/placement) · member ·
schedule · runner(+lease) · comment · notification · view · secret+api-key · integrations(5) ·
billing · queue+ops · auth · trace.
