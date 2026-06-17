# Assay

Harness-agnostic, infra-agnostic **agent evaluation runtime**. Register & version any agent
harness (Claude Code, Codex, LangGraph, …), run it across environments (repo / browser /
os-use) and OSes (Linux / Windows / macOS), and **score** it — fairly, repeatably, and with
regression tracking. Eval-first; just enough operational runtime to drive long, stateful,
isolated runs. Fully self-hosted.

## Why
`LangGraph` is the brain, `Fastify` is the door — Assay is the **operational + evaluation
layer** that makes running and grading arbitrary harnesses reliable: durable execution,
isolation, normalized traces, infra-agnostic drivers.

## Architecture (one-way deps)
```
core  ←  drivers | harnesses | graders  ←  runner  ←  apps/api
```
The product's spine is a 4-way separation: **Harness** (under test) · **Environment** (the
world it acts on) · **Driver** (where it runs) · **Grader** (how we judge). See `CLAUDE.md`
and `.claude/skills/foundation/`.

## Stack
TypeScript (Node 22) · pnpm + Turborepo · Fastify · Zod · Temporal · E2B (Linux v1) ·
LiteLLM proxy · Drizzle + Postgres · ClickHouse · Biome · Vitest · Docker/K8s/Helm.

## Develop
```bash
pnpm install
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Layout
- `packages/core` — contracts (interfaces + Zod + errors). Dependency root.
- `packages/{drivers,harnesses,graders}` — pluggable adapters.
- `packages/runner` — the eval loop (Temporal).
- `packages/registry` — harness version management.
- `apps/api` — Fastify control plane.
- `deploy/` — Docker/K8s/Helm + IaC.
- `docs/` — architecture, migration runbooks, diagnostics.

> Conventions are reinterpreted (not copied) from `digo-api` (backend) and `digo-infra-dev`
> (infra). See `CLAUDE.md`.
