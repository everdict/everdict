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
core ← { drivers · environments · harnesses · graders } ← runner ← agent ← backends ← apps/cli
```
- `core` — contracts only (interfaces + Zod + errors). No I/O, no SDK. Dependency root.
- `drivers` / `environments` / `harnesses` / `graders` — adapters; depend on `core` only.
- `runner` — the eval loop (`runCase`); composes adapters.
- `agent` — the dispatched unit (model B): runs `runCase` over `LocalDriver` inside an isolated job, emits `__ASSAY_RESULT__`.
- `backends` — placement: `Backend.dispatch(AgentJob)` → orchestrator (LocalBackend/NomadBackend; K8s/Windows later).
- `apps/cli` — control plane PoC. `apps/api` (Fastify) + `registry` are planned.

## The spine: 4 in-sandbox concerns + 1 placement layer
Harness (under test) · Environment (the world it acts on) · Driver (where it runs *in-sandbox*) · Grader (how we judge).
A run = provision(Driver) → seed(Environment) → install+run(Harness)→trace → snapshot(Environment) → grade(Grader[]).
**Backend** (placement, model B) wraps this: it dispatches the agent — which runs the above via
`LocalDriver` — to an orchestrator (Nomad/K8s/Windows) and parses the returned `CaseResult`.

## Topic map → references
- `references/architecture.md` — packages, the eval loop, Backend/agent (model B), how new types plug in.
- `references/conventions.md`  — naming, error model, null discipline, language policy, commits.
- Contracts in detail → skill `core-contracts`. Adapters → skills `drivers` / `harnesses` / `graders`.
- Distributed execution → skill `backends` (Backend vs Driver, AgentJob, model B).

## Critical rules (also pushed via .claude/rules)
- No `any` / no `!` / no silent nullable defaults; Zod-validate boundaries.
- Interfaces live in `core` (deliberate inversion of digo-api's no-interface rule — Assay is a plugin runtime).
- Cost is read from the harness trace (Claude reports `total_cost_usd`); LocalDriver uses the machine's `claude` login (no API key).
- Backends never run the harness — they dispatch the `@assay/agent` image and parse its `__ASSAY_RESULT__` output.
