# Harness playground — interactive test cases against a live harness session

> Ships the interactive half of execution-model.md's symptom 1 ("`run` only serves scorecards; a harness
> cannot be *experimented with*"). P1's experiment answered the batch shape (`POST /groups`, `_adhoc`);
> the playground answers the conversational one: **place the harness once, then throw test cases at it and
> watch it work, live** — no dataset, no graders, no cold dispatch per try.

## The shape

```
POST /sandboxes {harness:{id,version?,image?}}      boot: provision image → warm-install harness → session run
POST /sandboxes/:id/tasks {task}                    one test case → its own child Run (kind eval, group→session)
GET  /sandboxes/:id/tasks/:taskId/trace?since=N     the 2s live cursor (append-only buffer; sealed fallback)
GET  /sandboxes  ·  GET /sandboxes/:id              the reattach surface (record + live meta + task summaries)
POST /sandboxes/:id/close                           teardown: abort in-flight task → seal → settle → dispose
```

MCP twins: `create_sandbox` (harness branch) · `submit_sandbox_task` · `read_sandbox_task_trace` ·
`list_sandboxes` · `get_sandbox` (+ the existing `sandbox_exec`/`close_sandbox`). Web: the infra panel's
**playground tab** (boot form → task composer → live task cards), entry from the harness detail header.

## Ledger model (nothing new — deliberately)

- **The session** is the P6 sandbox run unchanged: `Run{kind:"sandbox", lifetime:"session"}`, TTL on the
  row, caps, the durable reaper, trajectory sealed at teardown. A harness session stamps the REAL harness
  `id@version` on the harness column, `attach:["exec","tasks"]`, and keeps `caseId`/`session.image` as the
  concrete container image.
- **Each test case** is `Run.newSessionCase`: `kind:"eval"`, `class:"interactive"`, `lifetime:"task"`,
  `trigger:"playground"`, `group:{id: <session runId>, role:"case"}` — the agent-turn idiom (O1) applied
  to the harness under test. Born running (the warm container starts synchronously; provision happened at
  session create). `caseSpec` persists the prompt case (`env:{kind:"prompt"}`, `graders:[]`) so the run
  detail shows what was asked; settle reuses `succeed`/`fail`, so `run.submitted`/`run.completed`/
  `run.failed` facts, billing (`billingCharges` → budget settle + usage meter) and the run-detail page all
  come for free. Later judge-scoring / "promote to scorecard" needs no new data model.
- **Evidence**: the child's events seal as its own trajectory (`source:"run"`) at settle — partial trace
  included on failure/cancel. The session's own trajectory holds only `task.start`/`task.end` boundary
  markers (pointers, no duplication).

## Liveness — how "watching it work" actually works

1. `ComputeHandle.execStream?` (contracts): optional streaming exec — exec's result contract with chunks
   delivered as they arrive. `DockerComputeHandle`/`LocalComputeHandle` implement it over one shared spawn
   core (`packages/drivers/src/spawn.ts` — the hardened close-first/exit-grace/group-kill/124 semantics the
   echo paths evolved).
2. `ClaudeCodeHarness` picks the incremental path when `execStream` is present: stream-json parsed PER LINE
   (`ChunkLineQueue`) and each `TraceEvent` yielded immediately. Same mapper, same events — the buffered
   eval path is untouched. `CommandHarness` stays buffered in v1 (its platform-trace `collectTrace` would
   double-report against incremental `log` events; a follow-up rung).
3. The session service appends each yielded event to the task's append-only buffer; the web polls
   `trace?since=<cursor>` every 2s. The cursor is a plain array index; `since` omitted = full replay (the
   panel unmounts on tab switches — all durable state is server-side). After settle the SAME endpoint
   serves the sealed trajectory, so a refresh mid-completion is lossless; `done:true` stops the poll.

## Discipline (the parts that are easy to get wrong)

- **One task at a time per session** (409 naming the active run): one container workdir sequence, one warm
  toolchain — parallel tasks would contend and muddy the live feed. Parallelism = more sessions.
- **Case independence with a warm container**: `scopedComputeHandle(handle, "tasks/<n>")` rebases relative
  cwd/paths per task (docker `-w` needs the dir to exist — mkdir once per rebased cwd). Absolute `workDir`
  specs opt out of isolation (documented caveat). Installed toolchain/deps stay warm at the container level.
- **Warm-install-before-record**: provision → `mkdir work` → `harness.install` → only then the ledger row.
  A failed install disposes the container and leaves nothing (`HARNESS_INSTALL_FAILED`).
- **Secrets never persist**: the composition-root resolver (registry get → `resolveHarnessSecrets` →
  `resolveSpecModel` model binding → `makeHarness(sandboxInstall)`) keeps resolved values only in the
  process-local session map; they reach the container via `RunContext.apiKeyEnv` / spec env (`docker exec
  -e`). Records, caseSpec, traces and markers carry none. `harnessAuthEnv` picks the
  `HARNESS_AUTH_ENV_VARS` vocabulary from workspace→personal secret tiers — the loginless container's
  substitute for a machine login. (Pre-existing docker property: `-e` values are visible in the host
  process table during an exec.)
- **Admission**: `budget.admit` (402) before any child record; `budget.release` if the create fails. One
  admit = one metered run, settled from the trace's own cost lines like every run.
- **Teardown mid-task**: close/expiry aborts the drive (`AbortSignal`), waits a bounded grace for the
  child to settle `failed{CANCELLED}`, seals partial evidence, then disposes. If the drive is stuck on an
  exec, the dispose kills the container and the child still settles (late, but terminal).
- **Recovery**: `canRedispatch()` excludes `placement.where === "driver"` — a CP crash must tombstone an
  orphaned playground case (`failed{INTERRUPTED}`), never re-dispatch a prompt case through the backend
  lane. The in-memory live buffer dies with the process (rung-1 cost, same as session traces).
- **Imageless specs**: `kind:"process"` harnesses (claude-code) declare no image — `harness.image` on the
  create body supplies one (400 with the fix named otherwise). `makeHarness(..., {sandboxInstall:true})`
  makes built-ins install their CLI into the bare image.

## v1 limits (named, not implied)

- Placement is the P6 **driver lane** (docker on the control plane, `EVERDICT_SANDBOX_DRIVER=docker`
  opt-in). Dispatching a session to a tenant runtime is a later rung, same record/UI (the placement-ladder
  rule).
- The synchronous warm install can hold `POST /sandboxes` for tens of seconds (npm/pip). An async
  "warming" state is a later rung.
- No conversational continuity between test cases (claude `--resume` has no plumbing) — cases share the
  container, not the harness's memory. A harness-contract extension if ever wanted.
- No envelope admission on session create (no `causedByRunId` input today); tenant budget only.
- `CommandHarness` events arrive at settle (buffered); `ClaudeCodeHarness` streams.
