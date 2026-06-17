# Convention system — two layers (reinterpreted from digo-api)

We split "how to build Assay" knowledge by **how the knowledge fails**:

## PUSH layer — `.claude/rules/*.md`
- Frontmatter `paths:` glob → auto-injected when a matching file is read/edited.
- Owns **short rules that conflict with ecosystem defaults** — things the model would
  otherwise "do the standard TS way" and get wrong for Assay.
- Keep each file thin (~20 lines): inlined critical rules + a pointer to the matching skill.

## PULL layer — `.claude/skills/*/`
- Model-driven: matched via frontmatter `description`, or invoked explicitly as `/name`.
- Owns **look-up knowledge the model knows it doesn't know** — pattern recipes, the eval
  domain model, driver/harness specifics.
- Each skill = a slim `SKILL.md` (checklist + critical rules + topic map, ≤~100 lines) +
  a `references/` folder for detail.

## Skills (pull)
- `foundation/`     — module deps, contracts, error model, conventions, workflow.
- `core-contracts/` — the EvaluableHarness / Environment / Driver / Grader contracts + Zod.
- `drivers/`        — implementing a Driver (E2B v1; pool drivers later).
- `harnesses/`      — implementing an EvaluableHarness + trace normalization + LLM proxy.
- `graders/`        — implementing a Grader; the metric families.
- `api-layer/`      — Fastify route/schema/service split, envelope, pagination.
- `testing/`        — Vitest, scenario E2E, regression-on-fix.
- `infra-deploy/`   — Docker/K8s/Helm, IaC, secrets, GitOps (reinterpreted from digo-infra).
- `docs-update`     — `/docs-update` command: audit drift between code and skill references.

Language: all skill/rule bodies are **English** (see CLAUDE.md language policy).
