---
name: foundation
description: Read FIRST. Assay's architecture, module boundaries, error model, naming and workflow conventions. Use whenever editing any package or starting a task.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Foundation

Assay is a harness-agnostic, infra-agnostic **agent evaluation runtime**. Eval-first.

## Checklist before coding
1. Confirm which package you're in and its allowed dependencies (one-way, below).
2. If you touch a contract in `core`, update its Zod schema + the `core-contracts` skill in the same PR.
3. Use `AppError` for failures; remap any external/SDK error.
4. Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before finishing.

## Module dependency (one-way; reverse import = bug)
```
core  ←  drivers | harnesses | graders  ←  runner  ←  apps/api
registry depends on core; apps/api depends on runner + registry.
```
- `core` — contracts only (interfaces + Zod + errors). No I/O, no SDK. Dependency root.
- `drivers` / `harnesses` / `graders` — adapters; depend on `core` only.
- `runner` — the eval loop (`runCase`), Temporal-orchestrated; composes adapters.
- `apps/api` — Fastify control plane.

## The 4-way separation (the product's spine)
Harness (under test) · Environment (the world it acts on) · Driver (where it runs) · Grader (how we judge).
A run = provision(Driver) → seed(Environment) → install+run(Harness)→trace → snapshot(Environment) → grade(Grader[]).

## Topic map → references
- `references/architecture.md` — packages, the eval loop, how future OS/env types plug in.
- `references/conventions.md`  — naming, error model, null discipline, language policy, commits.
- Contracts in detail → skill `core-contracts`. Adapters → skills `drivers` / `harnesses` / `graders`.

## Critical rules (also pushed via .claude/rules)
- No `any` / no `!` / no silent nullable defaults; Zod-validate boundaries.
- Interfaces live in `core` (deliberate inversion of digo-api's no-interface rule — Assay is a plugin runtime).
- Harness model calls go through the LLM proxy for harness-agnostic cost capture.
