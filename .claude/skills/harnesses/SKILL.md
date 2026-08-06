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
1. Implement `EvaluableHarness` (`packages/core/src/harness/harness.ts`); carry a pinned `version` (the unit of versioning).
2. `run()` MUST yield normalized `TraceEvent`s — convert native output in an adapter, never leak raw output upstream.
   A harness whose trace lands on an external platform (OTel/MLflow) does NOT pull it in `run()` — implement
   the optional `traceSource()`/`collectTrace(runId)` hooks; `runCase` pulls **after compute release**
   (correlate with `ctx.runId` — it injects the same id it later collects by). See
   `docs/architecture/streaming-case-pipeline.md` D4. **A configured platform source is ADDITIVE, never a
   substitute**: keep yielding your own account of the run (what you invoked, how it ended, the output you
   saw), because a dead endpoint or a wrong correlation key must not leave everdict's ledger empty for a run
   we performed. Only the ANSWER is single-sourced — don't promote raw output to an assistant `message` when
   the platform's trace already carries the answer (file it as a `log` instead).
3. Cost/tokens come from the harness's **own trace** (`llm_call.cost`, e.g. Claude `total_cost_usd`) — never measured by us.
4. Do all work through the provided `ComputeHandle` (`compute.exec`, cwd `work`); assume no host state.
5. Map install/run failures to `AppError` (`HARNESS_INSTALL_FAILED` / `HARNESS_RUN_FAILED`).
6. **Prefer a declarative `CommandHarness` spec over new code** (below) — new TS code needs an image rebuild.

## The contract
`EvaluableHarness` (`packages/core/src/harness/harness.ts`): `{ id, version, install(compute), run(compute, task, ctx) }`.
`run` is an `AsyncIterable<TraceEvent>`; `RunContext = { apiKeyEnv, timeoutSec, runId? }` (`runId` = the trace
correlation key `runCase` mints and later collects by). `apiKeyEnv` is usually
**empty** — `LocalDriver` uses the machine's own `claude` login (own-pays); keys are injected only in a
keyless sandbox. The interface lives in `core` (a deliberate inversion of the single-impl "no interfaces" rule — Everdict is a
plugin runtime); impls live in `packages/harnesses`. The dispatch factory `makeHarness(id, version, spec?)`
(`packages/job-runner/src/registry.ts`) picks the impl: `spec.kind==="command"` → `CommandHarness`, else id-branch.

**Multi-turn conversation (opt-in capability):** `RunContext.conversation?: { resume?, onToken? }` (in-process
only, like `signal`) + the `readonly conversational?: true` marker on the harness. A conversational harness
honors `resume` (continue the previous turn) and reports THIS turn's token via `onToken` — possibly more than
once, last-wins (a resumed claude run mints a NEW session id). The caller (the playground's conversation
sessions) checks the MARKER before provisioning and keeps ONE stable workdir across turns — claude keys its
session store off the cwd, so per-task cwd rebasing breaks resume structurally. A harness without the marker is
refused conversation mode up front; never silently start fresh. `ClaudeCodeHarness` is the reference
(`--resume <id>` + `claudeSessionId` capture from the stream-json init/result lines).

## Reference impls (`packages/harnesses/src/`, re-exported via `index.ts`)
- `ClaudeCodeHarness` (`claude-code.ts`) — real Claude Code CLI: runs `claude -p <task> --output-format
  stream-json --verbose --dangerously-skip-permissions` in the sandbox, feeds each JSON line to `mapClaudeStreamJson`.
- `ScriptedHarness` (`scripted.ts`) — deterministic test double: really runs planned `compute.exec` steps and
  emits real `tool_call`/`tool_result` events. No LLM/API key — proves the whole eval loop end to end.
- `CommandHarness` (`command.ts`) — the declarative one (below); the preferred way to add a harness.

## Declarative CommandHarness (any CLI agent, no code)
`CommandHarnessSpec` (`packages/core/src/harness/harness-spec.ts`, `kind:"command"`) makes onboarding a CLI agent
**data, not code**: `{ setup[], command, model?, env, params, trace }`. `install()` runs each `setup` line;
`run()` templates `command` — `{{task}}` (auto shell-quoted via `shq`, don't wrap it), `{{model}}`, `{{run_id}}`,
plus any `{{key}}` from `params` (reserved tokens substituted first so params can't clobber them) — then
`compute.exec`s it (cwd `spec.workDir ?? "work"`, with `EVERDICT_RUN_ID` + resolved `spec.env`). The control plane
resolves the spec from the registry and embeds it in the `CaseJob`; `makeHarness` builds the generic
`CommandHarness`. Full spec + tokens: `docs/command-harness.md`.
- **`model` = a registered-Model binding** (`string | ModelRef`, `docs/models.md`), not just the `{{model}}` slot.
  When it resolves to a registered Model, `ModelResolvingDispatcher` (`apps/api`) injects that model's connection
  (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` etc. — the key from the model's `apiKeySecret`) into `env` at
  dispatch, so the agent server gets its whole connection from one id instead of a hand-wired env combo. An
  unregistered bare string stays a literal (legacy). `command.ts` only ever sees the resolved `{{model}}` string.

## Incremental yield (live sessions)

`run()` is an `AsyncIterable` — yield events AS THEY HAPPEN when the compute allows it. Convention: when
`compute.execStream` is present (see skill `drivers`), parse the native output incrementally and yield per
unit (ClaudeCodeHarness: per stream-json line via `ChunkLineQueue`, `packages/harnesses/src/line-stream.ts`);
when absent, keep the buffered path BYTE-FOR-BYTE unchanged — the eval lane must not drift. The event
sequence must be identical on both paths (same mapper); only arrival time moves. A hard CLI failure
(non-zero exit) on the streaming path yields a trace-visible `error` event. Consumer: the harness
playground (`docs/architecture/harness-playground.md`) — a live session shows tool calls mid-run.
`makeHarness(..., {sandboxInstall: true})` makes built-ins install their CLI into a bare session container.

## Trace normalization (`stream-json.ts`)
Graders only read the normalized event stream, so every harness converts its native output to `TraceEvent[]`
(`packages/core/src/execution/trace.ts`: `message` / `llm_call` / `tool_call` / `tool_result` / `env_action` / `error`).
`mapClaudeStreamJson(obj, nextT)` maps one Claude `stream-json` line: `assistant` → `message`/`tool_call`
(+ `llm_call` from `message.usage`), `user` → `tool_result`, `result` → an aggregate `llm_call` carrying
`total_cost_usd`. **Cost/tokens ride in `llm_call.cost` from the harness's own report**; `usageFromTrace`
(same file) sums them — we never meter cost ourselves. Exceptions: a `trace:none` CommandHarness emits its
stdout tail as one `assistant` message (for QA grading), and `meterUsage` (opt-in) can proxy an OpenAI-base
black-box harness to recover a synthetic `llm_call`.

Beside the harness's own report sits OUR report of the same run: `CommandHarness` always emits an `env_action`
`command.exit` (command · exit code · duration) and the stdout/stderr tails as `log`s, whatever `trace` is set
to. That is the half no external platform can be trusted to hold for us.

**Every event a harness mints carries `at` — build it with `stamp(now)` (`@everdict/contracts`), never
`t: Date.now()` by hand.** `t` is the emitter's own scalar (a step index here, epoch ms there); `at` is the
absolute instant, and it is the ONLY thing that puts an event on the trajectory reader's shared axis. Without
it the reader must guess `t`'s unit, and guessing is how a self-reported trace numbered 1,2,3… drew fifteen
agent steps inside the first fifteen *milliseconds* of a twenty-three second run. Stamp the span edges too —
`spanId` on a `tool_call` (the call IS the span; mint none for an anonymous call so two never collapse into one
node) and `parentId` on the `tool_result` that answers it — or the waterfall can only draw a flat list. All of
it is additive and optional in the schema: graders and judges are untouched. A `trace:file` CommandHarness
passes the AGENT's events through verbatim, so there the stamping is the agent's job (`docs/command-harness.md`).

## Cross-refs & non-goals
- **Where it runs** = skill `drivers` (`ComputeHandle`, `LocalDriver`) + skill `backends` (placement of the agent job).
- **Scoring is separate** = skill `evaluation` (graders/judges read the trace; the harness never scores itself).
- **Service-topology harnesses are a different kind** (`kind:"service"`, multi-service + target env, trace pulled
  from OTel/MLflow) — see skill `topology`, not this one.

See `docs/command-harness.md` for the declarative spec + template tokens; the rule `harnesses.md` has the inlined critical rules.
