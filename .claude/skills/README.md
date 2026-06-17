# Convention system — two layers (reinterpreted from digo-api)

We split "how to build Assay" knowledge by **how the knowledge fails**:

## PUSH layer — `.claude/rules/*.md`
- Frontmatter `paths:` glob → auto-injected when a matching file is read/edited.
- Owns **short rules that conflict with ecosystem defaults** — things the model would
  otherwise "do the standard TS way" and get wrong for Assay.
- Keep each file thin (~20 lines): inlined critical rules + a pointer to the matching skill.
- Current rules: `typescript`, `core-contracts`, `drivers`, `harnesses`, `graders`, `agent`,
  `backends`, `orchestrator`, `api-layer`, `testing`, `infra-deploy`.

## PULL layer — `.claude/skills/*/`
- Model-driven: matched via frontmatter `description`, or invoked explicitly as `/name`.
- Owns **look-up knowledge the model knows it doesn't know** — pattern recipes, the eval
  domain model, driver/harness/backend specifics.
- Each skill = a slim `SKILL.md` (checklist + critical rules + topic map, ≤~100 lines) +
  a `references/` folder for detail.

## Skills (pull)
- `foundation/`     — module deps, the spine (4 concerns + Backend placement), error model, conventions.
- `backends/`       — distributed execution: Backend vs Driver, `AgentJob`, model B (Nomad/K8s/Windows).
- `core-contracts/` — the EvaluableHarness / Environment / Driver / Grader contracts + Zod (planned).
- `drivers/`        — implementing a Driver (in-sandbox compute; Local) (planned).
- `harnesses/`      — implementing an EvaluableHarness + trace normalization (planned).
- `graders/`        — implementing a Grader; the metric families (planned).
- `api-layer/`      — Fastify route/schema/service split, envelope, pagination (planned).
- `testing/`        — Vitest, scenario E2E, regression-on-fix (planned).
- `infra-deploy/`   — Docker/K8s/Helm, IaC, secrets, GitOps (planned).
- `docs-update`     — `/docs-update` command: audit drift between code and skill references (planned).

(`foundation` and `backends` exist today; the rest are stubs to fill as those areas grow.)

Language: all skill/rule bodies are **English** (see CLAUDE.md language policy).
