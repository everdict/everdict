# Harness playground — interactive test cases against a live harness session

> Ships the interactive half of execution-model.md's symptom 1 ("`run` only serves scorecards; a harness
> cannot be *experimented with*"). P1's experiment answered the batch shape (`POST /groups`, `_adhoc`);
> the playground answers the conversational one: **place the harness once, then throw test cases at it and
> watch it work, live** — no dataset, no graders, no cold dispatch per try.

## The shape

```
POST /sandboxes {harness:{id,version?,image?,conversation?}, runtime?}
                                                    boot: provision image → warm-install harness → session run
                                                    (service harness: ensure warm topology on the named runtime)
POST /sandboxes/:id/tasks {task, fresh?}            one test case / conversation turn → its own child Run
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
- Conversational continuity exists (see the Conversations section) for `conversational` process harnesses
  (claude-code) and service harnesses; `CommandHarness`/other CLIs still refuse conversation mode by name.
- No envelope admission on session create (no `causedByRunId` input today); tenant budget only.
- `CommandHarness` events arrive at settle (buffered); `ClaudeCodeHarness` streams.

## Conversations — multi-turn against the harness under test

The playground's second mode: instead of independent test cases, every submitted task continues ONE
conversation. The session picks its mode at boot and never flips; the web renders the same feed chat-shaped
(turn bubbles, the reply as the prominent message). Both flavors share the routes above, the one-at-a-time
409, budget admission, and the child-run-as-monitoring-handle — a conversation turn is
`Run.newSessionCase(role:"turn")` (caseId `turn-<n>`, `group.role:"turn"` = dependent evidence; boot
recovery never re-dispatches a turn, and aggregations over `role:"case"` children must not ingest turns).

**Process harnesses (`harness.conversation: true`)** — continuity is the harness's own resume mechanism:
- The contract is `RunContext.conversation: {resume?, onToken?}` (in-process only, like `signal`) plus the
  `EvaluableHarness.conversational` capability marker. A harness without the marker refuses conversation
  mode at create, BEFORE any container is provisioned — silently-fresh turns would be a lie. `CommandHarness`
  has no marker in v1.
- `ClaudeCodeHarness` implements it: `claude --resume <session-id>` continues the thread, and the session id
  is captured from the stream-json init AND result lines (`claudeSessionId`, last-wins — a resumed run mints
  a NEW id). The token lives only on the process-local session state (a CP restart orphans the session
  anyway — the existing honest-failure stance).
- One stable workdir: conversation turns share `scopedComputeHandle(handle, "conversation")` (claude keys
  its session store off the cwd — `tasks/<n>` rebasing would break resume structurally). `fresh: true` on a
  submit starts a new thread while deliberately keeping the workdir — "reset the chat, keep the environment".

**Service harnesses (front-door conversations)** — continuity is session-stable wiring:
- A `kind:"service"` harness ref routes to the front-door branch (this is also what fixed the old misleading
  404): the spec is secret- and model-resolved exactly like the dispatch lane, the topology environment comes
  from the SHARED per-`rt:<tenant>:<id>@<version>` memo (one `TopologyRuntime` instance for the eval lane AND
  conversations — one warm pool, one idle sweeper), and `FrontDoorSession` (`@everdict/topology`) drives it
  behind the structural `ServiceConversation` port. Boot = `ensureTopology` + the front-door endpoint (+ the
  per-SESSION target when the spec declares one — one browser for the whole conversation); each turn re-calls
  `ensureTopology` (touch-on-use — an active conversation cannot idle out).
- The wiring split IS the conversation: session-stable = the isolateBy vars (`thread_id`/`key_prefix`/
  `object_prefix`/`schema`, derived from the SESSION run id — one `thread_id` across submits is what makes a
  checkpointing agent resume) + `stream_channel`/`minio_prefix` + target coordinates; per-turn fresh =
  `run_id`, the trace correlation key, `callback_url` (the rendezvous holds one waiter per key). A
  session-stable `contextId` (e.g. `{{thread_id}}`) pulls the conversation's CUMULATIVE trace, so the session
  slices each turn's delta past what earlier turns already returned. `fresh` is refused (400) — a service
  conversation's thread is its session; open a new session to start over.
- The ledger row: `trigger:"frontdoor"` (its OWN capacity pool, `EVERDICT_FRONTDOOR_MAX_PER_TENANT`/
  `_MAX_TOTAL` — a warm-topology slot on a tenant cluster is a different scarcity than a CP container),
  `session.conversation:true`, `session.image` = the front-door service's image, NO `computeId` (the
  crash-path reaper settles row-only; the orphan sweep scans both pools). `exec`/`snapshot`/`git-push` refuse
  by name — there is no container. Placement is a REGISTERED workspace runtime only (`runtime` required,
  nomad/k8s with a `traceSource` = topology-capable) — the control plane deliberately hosts no topology.
- The assistant's reply is the front-door result channel (`responseText`); the turn's evidence buffer is
  infra marks → the agent's trace (inline or pulled delta) → the reply as a `message` event, so
  `lastAssistantText`, the chat UI and the sealed trajectory all read it like any harness turn. A turn past
  its budget fails with `completion-timeout` (+ `runtime.diagnose` naming a sick service); the SESSION stays
  alive for the next message. Trace-completion (`completion.mode:"trace"`) harnesses are refused — their
  front-door returns no reply to converse with.
- Known v1 leak: a crash-orphaned held target (the per-session browser) is not reaped by the row-only settle
  — it is bounded by the target job's own lifecycle on the cluster.

### Delegation profiles — booting a conversation from a registered environment

The conversation lane's third entry (beside a process harness and a service harness): `POST /sandboxes
{profile:{id}, brief}` boots a **delegation capability** — a registered work environment (image · which
conversational agent · model binding · env/secrets · standing instructions) referenced once instead of
re-specified per call. The session is a conversation by definition; the profile's `workDir` is the stable cwd
(turns run there directly — no `tasks/<n>`, no `conversation/` rescoping, or the delegate walks away from the
context seeded beside it); the standing instructions and the rendered brief are written into that directory
BEFORE the ledger row exists, and the brief is sealed on the trajectory as a `delegation.brief` marker.
Design + the env-precedence rule: `docs/architecture/capability-store.md` §Fifth kind.

## Agent worlds (W1) ride the same session

A sandbox session opened with `world:{id}` becomes a PERSISTENT environment: its filesystem is
snapshotted (host-side `docker commit` + push) into the managed image store and registered as an
environment-capability version, and the next `world` session boots from the latest snapshot —
expiry hibernates instead of losing state. See `docs/architecture/agent-worlds.md`.
