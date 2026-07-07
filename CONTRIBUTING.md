# Contributing to Everdict

Thanks for your interest! Everdict is a harness-agnostic agent evaluation runtime — contributions of
harness adapters, graders, runtime backends, docs, and bug fixes are all welcome.

## Dev setup

```bash
# Node >= 22, pnpm 9 (repo pins pnpm via "packageManager")
corepack enable
pnpm install
pnpm build          # turbo build across packages

# optional but recommended — format/lint + gitleaks on every commit:
pipx install pre-commit && pre-commit install
```

Fast full-stack loop (web + API, auth off): `docker compose -f deploy/compose/docker-compose.dev.yaml up --build`
— see `deploy/compose/README.md` and `docs/dev.md`.

## Read first, code second

Conventions live in [`CLAUDE.md`](CLAUDE.md) and `.claude/` (rules + per-area skills) — they are the
single source of truth for how this repo is built (layering, error model, null discipline, naming).
The short version:

- One-way dependencies: `core` is the root; adapter packages implement its interfaces. Reverse imports are bugs.
- No `any`, no non-null `!`, no silent nullable defaults; validate every boundary with Zod.
- Errors: throw an `AppError` subclass from `@everdict/core`; never propagate a raw SDK/HTTP error.
- Language policy: docs/rules in English, code comments in Korean (this is intentional — match the
  surrounding code; don't "fix" existing comments' language).

## Quality gates (all five must pass)

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`apps/web` is self-contained: `pnpm -F @everdict/web lint` + `pnpm -F @everdict/web build`.

## Tests

Vitest only. Units use in-memory stores / fake dispatchers; the API surface is tested via
`buildServer` + Fastify `inject`; Postgres logic via a fake `SqlClient`. Anything needing real
infra (DB/Nomad/K8s/MLflow/Keycloak) is an env-gated `*.scenario.test.ts` or a `scripts/live/*.mjs`
proof — never a required unit test. See `.claude/skills/testing/SKILL.md`.

## Commits & PRs

- Conventional Commits, scoped: `feat(drivers): …`, `fix(runner): …`. The body explains the *why*.
- Every `fix:` ships a regression test that fails on the pre-fix code.
- A PR that changes a convention/invariant updates the matching `.claude/` skill/rule **in the same PR**.
- Sign off your commits (DCO): `git commit -s` adds the `Signed-off-by:` trailer, certifying
  [developercertificate.org](https://developercertificate.org/).

## Reporting bugs / requesting features

Use the issue templates. For security vulnerabilities, **do not open a public issue** — see
[SECURITY.md](SECURITY.md).
