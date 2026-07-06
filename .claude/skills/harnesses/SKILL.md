---
name: harnesses
description: The agent under test (Claude Code / Codex / any CLI) driven over a process boundary, plus normalization of its native output into a TraceEvent stream. Use when implementing or editing an EvaluableHarness (the agent under test) or trace normalization.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Harnesses (the agent under test)

A harness = the agent being evaluated, driven **over a process boundary** (so it can be any
language/CLI). It `install`s into a sandbox, `run`s a task, and yields a **normalized trace**. It
never scores itself — `graders` read the trace and the env snapshot (see skill `evaluation`).

## Checklist
1. Implement `EvaluableHarness` (`packages/core/src/harness.ts`); carry a pinned `version` (the unit of versioning).
2. `run()` MUST yield normalized `TraceEvent`s — convert native output in an adapter, never leak raw output upstream.
   A harness whose trace lands on an external platform (OTel/MLflow) does NOT pull it in `run()` — implement
   the optional `traceSource()`/`collectTrace(runId)` hooks; `runCase` pulls **after compute release**
   (correlate with `ctx.runId` — it injects the same id it later collects by). See
   `docs/architecture/streaming-case-pipeline.md` D4.
3. Cost/tokens come from the harness's **own trace** (`llm_call.cost`, e.g. Claude `total_cost_usd`) — never measured by us.
4. Do all work through the provided `ComputeHandle` (`compute.exec`, cwd `work`); assume no host state.
5. Map install/run failures to `AppError` (`HARNESS_INSTALL_FAILED` / `HARNESS_RUN_FAILED`).
6. **Prefer a declarative `CommandHarness` spec over new code** (below) — new TS code needs an image rebuild.

## The contract
`EvaluableHarness` (`packages/core/src/harness.ts`): `{ id, version, install(compute), run(compute, task, ctx) }`.
`run` is an `AsyncIterable<TraceEvent>`; `RunContext = { apiKeyEnv, timeoutSec, runId? }` (`runId` = the trace
correlation key `runCase` mints and later collects by). `apiKeyEnv` is usually
**empty** — `LocalDriver` uses the machine's own `claude` login (own-pays); keys are injected only in a
keyless sandbox. The interface lives in `core` (a deliberate inversion of digo's "no interfaces" — Assay is a
plugin runtime); impls live in `packages/harnesses`. The dispatch factory `makeHarness(id, version, spec?)`
(`packages/agent/src/registry.ts`) picks the impl: `spec.kind==="command"` → `CommandHarness`, else id-branch.

## Reference impls (`packages/harnesses/src/`, re-exported via `index.ts`)
- `ClaudeCodeHarness` (`claude-code.ts`) — real Claude Code CLI: runs `claude -p <task> --output-format
  stream-json --verbose --dangerously-skip-permissions` in the sandbox, feeds each JSON line to `mapClaudeStreamJson`.
- `ScriptedHarness` (`scripted.ts`) — deterministic test double: really runs planned `compute.exec` steps and
  emits real `tool_call`/`tool_result` events. No LLM/API key — proves the whole eval loop end to end.
- `CommandHarness` (`command.ts`) — the declarative one (below); the preferred way to add a harness.

## Declarative CommandHarness (any CLI agent, no code)
`CommandHarnessSpec` (`packages/core/src/harness-spec.ts`, `kind:"command"`) makes onboarding a CLI agent
**data, not code**: `{ setup[], command, model?, env, params, trace }`. `install()` runs each `setup` line;
`run()` templates `command` — `{{task}}` (auto shell-quoted via `shq`, don't wrap it), `{{model}}`, `{{run_id}}`,
plus any `{{key}}` from `params` (reserved tokens substituted first so params can't clobber them) — then
`compute.exec`s it (cwd `spec.workDir ?? "work"`, with `ASSAY_RUN_ID` + resolved `spec.env`). The control plane
resolves the spec from the registry and embeds it in the `AgentJob`; `makeHarness` builds the generic
`CommandHarness`. Full spec + tokens: `docs/command-harness.md`.

## Trace normalization (`stream-json.ts`)
Graders only read the normalized event stream, so every harness converts its native output to `TraceEvent[]`
(`packages/core/src/trace.ts`: `message` / `llm_call` / `tool_call` / `tool_result` / `env_action` / `error`).
`mapClaudeStreamJson(obj, nextT)` maps one Claude `stream-json` line: `assistant` → `message`/`tool_call`
(+ `llm_call` from `message.usage`), `user` → `tool_result`, `result` → an aggregate `llm_call` carrying
`total_cost_usd`. **Cost/tokens ride in `llm_call.cost` from the harness's own report**; `usageFromTrace`
(same file) sums them — we never meter cost ourselves. Exceptions: a `trace:none` CommandHarness emits its
stdout tail as one `assistant` message (for QA grading), and `meterUsage` (opt-in) can proxy an OpenAI-base
black-box harness to recover a synthetic `llm_call`.

## Cross-refs & non-goals
- **Where it runs** = skill `drivers` (`ComputeHandle`, `LocalDriver`) + skill `backends` (placement of the agent job).
- **Scoring is separate** = skill `evaluation` (graders/judges read the trace; the harness never scores itself).
- **Service-topology harnesses are a different kind** (`kind:"service"`, multi-service + target env, trace pulled
  from OTel/MLflow) — see skill `topology`, not this one.

See `docs/command-harness.md` for the declarative spec + template tokens; the rule `harnesses.md` has the inlined critical rules.
