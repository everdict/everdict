# Convention system — two layers

We split "how to build Everdict" knowledge by **how the knowledge fails**:

## PUSH layer — `.claude/rules/*.md`
- Frontmatter `paths:` glob → auto-injected when a matching file is read/edited.
- Owns **short rules that conflict with ecosystem defaults** — things the model would
  otherwise "do the standard TS way" and get wrong for Everdict.
- Keep each file thin (~20 lines): inlined critical rules + a pointer to the matching skill.
- Current rules: `protocol`, `typescript`, `core-contracts`, `drivers`, `harnesses`, `graders`, `job-runner`,
  `backends`, `orchestrator`, `trace`, `topology`, `api-layer`, `mcp`, `auth`, `db`, `registry`,
  `web`, `datasets`, `suite`, `events`, `workspace-integrations`, `testing`, `infra-deploy`, `ci`.
- **`protocol.md` is the cross-cutting one** — the five laws for the seam between a decision and an effect.
  It is pushed across the kernel + control plane because that seam is where this repo's defects recur, and
  they recur as *correct nouns consumed as annotations*, which no layering rule can see.

## PULL layer — `.claude/skills/*/`
- Model-driven: matched via frontmatter `description`, or invoked explicitly as `/name`.
- Owns **look-up knowledge the model knows it doesn't know** — pattern recipes, the eval
  domain model, driver/harness/backend specifics.
- Each skill = a slim `SKILL.md` (checklist + critical rules + topic map, ≤~100 lines) +
  a `references/` folder for detail.

## Skills (pull)
- `protocol/`       — **effects and authority**: the five laws, the design checklist to run BEFORE writing an
  effect path, the case law (every recurring defect with file, line, and the wrong reasoning verbatim), and
  the verification protocol (mutation-first, non-vacuous fixtures, when a scanner is legitimate).
- `foundation/`     — module deps, the spine (4 concerns + Backend placement), error model, conventions.
- `backends/`       — distributed execution: Backend vs Driver, `CaseJob`; the SaaS operational layer
  (capacity-aware + tenant-fair `Scheduler`, trust-zone isolation, secrets, budgets, autoscaling).
- `topology/`       — service-topology harnesses: HarnessSpec(service), warm-pool/shared-store/per-case efficiency, live `NomadTopologyRuntime` + per-tenant warm pools, Nomad+K8s, OTel/MLflow trace.
- `api-layer/`      — control-plane HTTP (`apps/api`, Fastify): async `POST /runs`/poll/webhook, `RunStore`, flat envelopes.
- `web/`            — the SaaS web app (`apps/web`): Next.js FSD, pure-HTTP token-courier BFF, `[workspace]` scoping, UI conventions.
- `evaluation/`     — the eval-first core: graders, judges, scorecards, regression/leaderboard, saved views, trace ingest.
- `self-hosted-runner/` — `self-hosted-runner` lease loop + the runtime/capability model + personal/workspace runner tiers.
- `desktop/`        — Electron shell (`apps/desktop`): renders the deployed web, origin-gated bridge, embedded runner.
- `core-contracts/` — the interfaces + Zod schemas + `AppError` model in `packages/core` (the dependency root).
- `drivers/`        — implementing a Driver (in-sandbox compute; `LocalDriver` + `DockerDriver`).
- `harnesses/`      — implementing an EvaluableHarness (the agent under test) + trace normalization.
- `graders/`        — implementing a single Grader (recipe); the scoring *domain* lives in `evaluation`.
- `testing/`        — Vitest, fake-injection units, `buildServer`+`inject`, env-gated live E2E (no Testcontainers).
- `ci/`             — local CI parity: mirror `.github/workflows/ci.yml` before ANY push (5 gates + cone/web-imports/boot + web job + gitleaks), confirm green after.
- `infra-deploy/`   — Docker/K8s/Helm, IaC, secrets, GitOps (planned — `deploy/` is dev compose so far).
- `docs-update`     — `/docs-update` command: audit drift between code and skill references (planned).

(Exist today: `protocol`, `foundation`, `backends`, `topology`, `api-layer`, `web`, `evaluation`,
`self-hosted-runner`, `desktop`, `core-contracts`, `drivers`, `harnesses`, `graders`, `testing`, `ci`,
`agent-runtime`, `evaluation`. Stubs: `infra-deploy` (waiting on real deploy infra), `docs-update`.)

Language: all skill/rule bodies are **English** (see CLAUDE.md language policy).
