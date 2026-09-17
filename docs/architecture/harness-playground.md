---
kind: wiki
title: "Harness playground — interactive test cases against a live harness session"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/sandbox/sandbox.routes.ts, packages/application-control/src/session/session-task-runner.ts, packages/application-control/src/session/frontdoor-turn-runner.ts, packages/drivers/src/spawn.ts]
---
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

## Limits (named, not implied)

- Placement: the lane exists only where the operator configured compute (`EVERDICT_COMPUTE`, or the lane's own
  alias `EVERDICT_SANDBOX_DRIVER`; `docker` or `nomad` — `apps/api/src/composition/compute-env.ts`). A create body
  with `runtime` places the session on a runtime the workspace registered instead (W4); a runtime that only runs
  jobs to completion cannot hold a session open and is refused by name.
- The synchronous warm install can hold `POST /sandboxes` for tens of seconds (npm/pip); there is no async
  "warming" state.
- Conversational continuity exists (see the Conversations section) for harnesses carrying the `conversational`
  marker — `ClaudeCodeHarness`, and a `CommandHarness` whose spec declares a `conversation` contract — and for
  service harnesses; any other harness refuses conversation mode by name.
- Admission: a session an agent opens (`agent.runId`) draws from its causer's envelope (`admitCausedWork`)
  before the tenant budget; a member's session answers the tenant budget only.
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
  carries the marker only when its spec declares `conversation` (its `command` must then hold the
  `{{conversation}}` slot).
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
re-specified per call. It is an OVERLAY on the target axis, so a delegate works anywhere a member can — its
own image, an adopted environment, a world it continues, or a world it founds (the profile's image being the
genesis base). The session is a conversation by definition; the profile's `workDir` is the stable cwd
(turns run there directly — no `tasks/<n>`, no `conversation/` rescoping, or the delegate walks away from the
context seeded beside it); the standing instructions and the rendered brief are written into that directory
BEFORE the ledger row exists, and the brief is sealed on the trajectory as a `delegation.brief` marker.
Design + the env-precedence rule: `docs/architecture/capability-store.md` §Fifth kind.

### Supervising the delegate — three deliveries, an interrupt, and a report

A delegation is a relationship, not a request. Four things make it supervisable, and each replaces something
that used to have exactly one answer.

**Reaching it.** `delivery` says what a message does to the turn the delegate is in: `message` queues without
starting or disturbing one, `task` (the default) starts a turn when the delegate is idle and queues for the
next boundary when it is not, `interrupt` aborts the turn first. `planDelivery` (`@everdict/domain`) owns the
decision; the answer says which happened (`{delivered:'started', run}` · `{delivered:'queued', queued,
state}`), because a caller that cannot tell them apart cannot know whether there is a trace to poll. Queued
items are drained together, in order, ahead of the next turn's prompt, with notes kept apart from work.
⚠️ The boundary is the END OF A TURN, not a message boundary inside one — we spawn a harness CLI and wait, so
there is no seam to inject at.

**Stopping it.** `POST /sandboxes/:id/interrupt` (`interrupt_sandbox_task`) aborts the turn and KEEPS the
session: container, working directory and conversation all survive, and the delegate takes the next
instruction immediately. Every turn has held an `AbortController` since the lane existed and teardown was its
only caller, so the one way to stop a delegate going the wrong way was `close_sandbox` — which destroyed the
container and every uncommitted change in it.

**Its state.** `DelegateState` is a union of seven: `pending_init` · `running` · `interrupted` ·
`completed{report?}` · `errored` · `closed` · `orphaned`. `completed` is deliberately not `closed` — a
finished delegate stays addressable until the supervisor lets it go, and that gap IS the review seam.
`orphaned` is the third value (rule `protocol` L2): the ledger has the session, this control plane does not
hold it, and that is neither an ending nor an absence.

**What comes back.** `doneWhen` criteria carry ids (`{id, statement}`), rendered into BRIEF.md so the delegate
can answer them by name. The delegate writes `REPORT.json` in its working directory — the brief came in as a
file and the report leaves as one, because a delegate has no channel to this control plane at all. The report
is a PROPOSED change round: `ChangeSetEntry`, `GateRun` and `ChangeJudgementAnswer`, the campaign lane's own
vocabulary rather than a second set of words for "what this work achieved". `reviewDelegateReport` pairs it
against the brief — unanswered criteria, answers to ids nobody asked for, duplicates, and `observed` answers
citing a measurement that is not in the file. It answers "is this even an answer?", never "is this good?".

### Delegating an issue — the brief assembled from the record

`POST /sandboxes {profile:{id}, issueId}` (`create_sandbox` with `issue`) is the high-level handoff: name the
issue and the brief is DERIVED from what the tracker already holds — the description, the commits already
linked to it, the issues it points at, and what the workspace has learned about them (`issueDelegationBrief`,
the issue-shaped sibling of `campaignRoundBrief`). Typing a brief instead drops exactly the parts hardest to
notice missing: the knowledge from a previous attempt, and the checks somebody would apply to the result.

⚠️ Related issues contribute their SUBJECT and never their resolution. A previous fix reads as the answer, and
a delegate handed one applies it — which is how one misdiagnosis becomes two. Same exclusion as the campaign
brief's held-out ids and scores, in a quieter form.

`issueId` and `brief` are mutually exclusive (two answers, no rule for choosing), `issueId` requires
`profile`, and an issue that cannot be read is a 404 rather than a delegate briefed on nothing.

## Agent worlds (W1) ride the same session

A sandbox session opened with `world:{id}` becomes a PERSISTENT environment: its filesystem is
snapshotted (host-side `docker commit` + push) into the managed image store and registered as an
environment-capability version, and the next `world` session boots from the latest snapshot —
expiry hibernates instead of losing state. See `docs/architecture/agent-worlds.md`.
