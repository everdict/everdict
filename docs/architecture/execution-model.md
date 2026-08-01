# The execution model — Run as the platform's universal execution record

> **Status: DESIGN (not implemented).** Doc-first SSOT for closing the "what is a Run?" question.
> Successor to [run-as-primitive.md](./run-as-primitive.md) (run ⊂ scorecard, CLOSED) and
> [execution-scoring-orchestration.md](./execution-scoring-orchestration.md) (execution / scoring /
> orchestration split, CLOSED), and the counterpart to [agent-automation.md](./agent-automation.md)
> (which built agent runs as a *parallel* ledger — the debt this design pays off).
>
> **Maintainer's intent:** execution has to *extend and then close*. Today it stays open-ended in three
> places: `run` only serves scorecards; a harness cannot be *experimented with* (driven without a dataset
> or a judge); and an agent's execution is not a run at all — it is welded to a chat panel, so autonomous,
> background and event-triggered agents have nowhere to show their trajectory and their artifacts.
>
> **And the stakes are throughput.** This is the platform's core wiring: above the real executions sit
> agent-created executions, and above those sit triggers — each layer *multiplies* demand onto real
> runtimes. Designed right, the run model is the lever that lets Everdict scale throughput at will
> (attach capacity, demand flows); designed wrong, it is the point where an agent expands compute without
> regard for resources and nothing structural stops it. §5 is the answer to that.

## Three symptoms, each grounded in the code

**1. `Run` is shaped for exactly one orchestrator.** `RunRecordSchema` requires `harness{id,version}` and
`caseId`; its payload is a `CaseResult`. The only thing that fans runs out is `ScorecardService`. Phase 1
(drive the harness → trace) and phase 2 (grade the trace → scores/aggregate) are separable in principle —
`POST /scorecards/ingest` proves it by scoring traces with **no run at all** — but there is no way to say
"just drive it" and no way to attach scoring to an execution *afterwards*. Note the model is already
permissive: `EvalCase.graders` defaults to `[]`, so an ungraded execution is representable. What is missing
is the surface, the repetition, and the after-the-fact scoring, not the data shape.

**2. A run is terminal, so context cannot accumulate.** A `RunRecord` is submit → result. There is no
lineage (this run is a retry of that one, with this pin changed), no link to what it produced (the
workspace files an agent wrote, the artifacts it offloaded), and — beyond `parentScorecardId` — no
grouping that says "these twelve runs are one experiment". An agent asked to *analyze* a body of work has
to reconstruct that from nothing. The join point does not exist.

**3. Agent execution is a second, parallel ledger.** `AgentSessionRecord` grew `origin{type: chat |
discussion | teammate | trigger | schedule | api}` and `status{running | awaiting_approval | completed |
failed | cancelled}` — that is a run in all but name, with the comment *"a conversation is not a run"*
written next to it. It lives in a different service (`apps/agent`), reaches the web through a different
client (`agentPlane`, `AGENT_URL`) on a different page (`/agents` fleet vs `/runs` console), and the event
log carries two near-identical families (`run.*` and `agent.run.*`). The record is still
*conversation-shaped*: a headless activation borrows a session and its messages, so the only way to look
at an autonomous agent's work is to read a chat transcript. `agent-automation.md` already recorded this as
gap #6 ("No run identity") and answered it inside the session record; this design answers it in the ledger.

**Corroborating fourth data point (fresh):** the Files viewer's Run (`POST /fs/executions`,
[workspace-filesystem.md](./workspace-filesystem.md)) executes user code in a sandbox and returns a result
that is **recorded nowhere**. It could not join the run list even though it is, plainly, a run. Three
different features have now each grown their own execution record.

**Fifth finding — the governance asymmetry (the throughput risk).** The eval dispatch path has a full
capacity plane: the Scheduler's tenant-fair WFQ with global *and* per-tenant queue-depth caps (429
backpressure), `interactive|batch` priority with an aging starvation guard, declared-resource admission
envelopes (`memFreeMb`/`cpuFree`), a queue-depth `Autoscaler`, a `CircuitBreaker`, and a persistent
per-tenant `BudgetTracker` whose `admit` throws 402 *before* dispatch. The agent path has **none of it**:
`apps/agent` meters cost *after* a turn (best-effort settle, workspace-billed only) and admits nothing;
per-agent budgets are recorded in agent-automation.md's v1 bounds as "not enforced yet". The command path
(`/fs/executions`) has no admission either. So the layers that **cause** compute are ungoverned while the
layer that **is** compute is well-governed — and amplification lives with the causers: one event → one
agent run → N scorecards → N×M eval runs. Today the only backstop against that tree is the eval queue's
per-tenant cap, which surfaces as mysterious 429s inside an agent's tool calls.

**Diagnosis.** Everdict has exactly one recurring noun and has spelled it three ways. The noun is: *an
activation of some executable, by some actor, in some environment, producing a trajectory and outputs,
optionally judged.* Harness cases, agent activations and file commands are the same shape.

## The model

### 1. Run — one activation, whatever was activated

`Run` becomes the universal execution record, discriminated by **kind** and carrying a kind-specific
**subject**:

```
Run {
  id, tenant, kind, subject, status, origin, placement, lifetime, attach[],
  group?, lineage?, trajectory (TraceEvent[]), outputs, usage, error?,
  createdBy, createdAt, updatedAt, expiresAt?
}

kind      = "eval" | "agent" | "command" | "sandbox" | "analysis"   // open enum, one per executable family
subject   = eval:     { harness{id,version}, caseId, caseSpec? }
            agent:    { agentId, agentVersion, model?, conversationId?, permissionMode }
            command:  { path, image, command }                // the Files viewer's Run
            sandbox:  { image, source? }                      // an environment image, brought up to be poked at
            analysis: { viewId | config }                     // the scheduled analysis report
status    = queued → running → (awaiting_input) → succeeded | failed | cancelled
origin    = { cause: "member" | "schedule" | "event" | "run" | "ci" | "api",
              actor?, scheduleId?, eventId?, eventKind?, causedByRunId? }
placement = { where: "inline" | "driver" | "runtime", target?, isolation? }   // §4
lifetime  = "task" | "session"                                // does it end by itself, or is it held open? §4
attach    = ("logs" | "exec" | "terminal" | "screen" | "cdp")[]              // channels this run exposes
class     = "interactive" | "background" | "batch"            // scheduling class — §5 (CaseJob's, made uniform)
envelope  = { id, capUsd?, capTokens?, capRuns? }              // the budget this run draws from + delegates — §5
group     = { id, role: "case" | "turn" | "child" }           // the orchestration this run belongs to
lineage   = { retryOf?, rescoreOf?, forkedFrom? }
outputs   = { artifacts[], files[], scores[], summary? }
```

Three properties do the work:

- **`status` is uniform**, so one activity console shows every execution, live, whatever produced it.
  `awaiting_input` generalizes the agent's `awaiting_approval` (a parked approval) and leaves room for any
  future HITL pause.
- **`trajectory` is uniform.** A harness's trace and an agent's turns are both `TraceEvent[]` — the trace
  contract already models tool calls, messages, tokens and cost. An agent transcript *is* a trace; storing
  it as one is what lets judges, the trace sink, replay and the analysis lenses work on agent runs for
  free. (This is the single highest-leverage claim in this design; see Open decision O2.)
- **`outputs` is the join point** that symptom 2 is missing: the artifacts a run offloaded, the workspace
  files it published (the filesystem already records the agent + conversation that wrote each revision),
  and any scores attached to it.

`kind: "eval"` keeps today's columns (`harness`, `caseId`, `parentScorecardId`, `runtime`) so the existing
surfaces do not move; the new fields are additive.

### 2. Run group — orchestration, and the second phase

A **run group** is "these runs are one thing", and it is where phase 2 lives:

```
RunGroup { id, tenant, kind, label, spec, runIds[], status (rollup), scoring? }
kind = "experiment"   // phase 1 only: drive a harness N times / over a dataset, no verdict
     | "scorecard"    // phase 1 + phase 2: the same runs, plus judges/graders and an aggregate
     | "conversation" // an agent's turns
     | "batch"        // any other fan-out
```

- **An experiment is a scorecard that stopped after phase 1.** Same fan-out, same runs, no judges, no
  aggregate — the user's "drive the harness without a dataset or a judge". It answers *"does this harness
  even work / what does it do"*, which is the question every harness author asks first and which the
  platform currently has no answer for.
- **Phase 2 becomes re-runnable and detachable.** Scoring a group = apply judges/graders over its runs'
  trajectories and aggregate. Because that is exactly what `/scorecards/ingest` already does to
  externally-produced traces, "promote this experiment to a scorecard" and "re-score with a different
  judge" are the same operation with different inputs. Scores attach to the run, the aggregate to the
  group; **re-scoring never mutates phase 1** (today's rule that re-scoring never edits the dataset,
  generalized).
- **A conversation is a group of turns.** This is what keeps the activity console readable: a 50-turn
  conversation and a 100-case batch both collapse to one row that expands — the grouping mechanism that
  `RunsTable` already implements for scorecard children.

### 3. Trigger — one way to cause a run

> **Plumbing designed: [event-plumbing.md](./event-plumbing.md)** — structural emission (aggregate
> transitions return facts, same-tx outbox), one log with N durable-cursor consumers, the coverage
> grammar, delivery semantics, and the engine convergence this section sketches (P7).


Everything that starts work becomes the same three-step shape:

```
platform event  →  subscription (trigger)  →  run
```

- **Events** already exist (`platform_events`, append-only, cursor-reconciled). Schedules become time
  events (`schedule.fired`), which the current design deliberately omitted; CI and the front-door already
  emit facts.
- **A subscription** binds a selector (event kind + filter) to a run spec (which agent / which harness /
  which analysis). Agent triggers are today's only instance and live in the agent service's matcher;
  schedules are a separate Temporal path; CI is a third. They do not have to merge on day one — what must
  unify is the **output**: every one of them creates a Run, and stamps `origin` with the cause.
- **Causation is a first-class edge.** A run created by an agent run carries `origin.causedByRunId`. That
  makes the existing loop guards (self-cause ban, depth cap, cooldown) enforceable from data rather than
  from per-engine bookkeeping, and it gives an analyst the causal chain: *this PR came from that failed
  case in that scorecard, via that agent run.*

### 4. Runs touch real runtimes — placement, attach, and runs you hold open

An execution is not only a record; it **occupies compute**. Some runs are a single API call, some bring a
container up in a tenant's cluster — and some exist *so that a person can go in and look around*. "Bring
this environment image up and give me a shell" is a run, and the platform has no name for it today.

**Two axes the record must carry.**

`placement` — *whose compute, how isolated*:

| where | what it means | who has it today |
|---|---|---|
| `inline` | the control-plane process itself (no sandbox) | analysis reports; API-only work |
| `driver` | a container the control plane owns (`DockerDriver`) | the Files viewer's Run — the weakest rung, opt-in behind a socket mount |
| `runtime` | dispatched to a tenant runtime (nomad / k8s / self-hosted) | every eval case |

Making this a field rather than an implicit property of the kind is what lets one thing move up the ladder
without changing what it is: the Files Run should become `placement.where: "runtime"` on a workspace that
registered one, with **the same record, the same UI, the same permissions** — only stronger isolation.

`lifetime` — *does it end by itself?*

- **task** — the work finishes and the run settles on an outcome (exit code, verdict, produced files). Every
  run today is this.
- **session** — the run is held open **on purpose** until it is closed, expires, or goes idle. Its outcome
  is not an exit code; it is "closed, and here is the trajectory of what was done inside".

**This machinery already exists — twice — and neither instance is a Run.**

1. **Eval-case attach.** `Backend.exec(caseId, cmd)` → `POST /runs/:id/exec` (+ MCP `exec_in_run`), a
   persistent WS shell behind one-shot `TerminalTicket`s, `GET /runs/:id/screen`, and the live log tail
   ([live-observability.md](./live-observability.md) ④⑤⑥, live-verified on Nomad). Everything needed to
   shell into a live sandbox is built — but only reachable **while an eval case happens to be running**.
   You cannot ask for the sandbox itself.
2. **Browser sessions.** `BrowserSessionService` provisions a live browser (docker / local / pooled /
   runtime-bound), hands out CDP + screencast + input, enforces a TTL (15m) and per-tenant concurrency
   caps (`RateLimitError` → 429), and reaps. That is a session run in every respect — with its own record,
   its own service, its own API and its own page.

So a third parallel ledger is exactly what "run an environment image and shell in" would become if it were
built as its own feature. Instead: **`kind: "sandbox"`, `lifetime: "session"`, `attach: ["terminal", …]`.**

**What a session run adds to the model** (and these are the parts that are easy to get wrong):

- **Disposal is the invariant.** Every session run has a hard `expiresAt`, an idle timeout, and exactly one
  owner of teardown. The Driver rule (`dispose()` in a `finally`) generalizes: for a session, **the reaper
  is the `finally`**. A session with no reaper is a leak with a bill attached.
- **Concurrency caps are per tenant, not per user.** Already true for browser sessions; a sandbox run is a
  scarcer resource than an eval case because nothing ends it. Reuse the same 429 shape.
- **`running` stops meaning "in progress".** An open shell sits in `running` for an hour legitimately. The
  activity console must distinguish it (`lifetime` is exactly that discriminator) or every ops view will
  read healthy sessions as stuck batches.
- **Idle cost is metered.** A task run's cost is bounded by its work; a session's is bounded only by the
  clock. Session runs must accrue against the same budget, and the fleet view must show what is burning.
- **Attach is not a read.** Exec runs arbitrary mutating commands inside the tenant's runtime. Today's rule
  (creator-or-admin, *stricter* than `runs:read`) generalizes unchanged, and the ticket flow — short-lived,
  single-use, bound to the run id — already fits a sandbox run with no redesign.

**Why this pays for itself immediately:** the environment store can today only check that an image is
*pullable* (`verify_image`). Actually bringing it up and looking inside is how an author verifies an
environment — and because the sandbox is a Run, that verification has a trajectory, a cost, an owner and a
place in the activity console, and it can be attached as evidence to the environment capability.

### 5. The capacity plane — throughput as a governed resource

Three graphs, and the discipline that connects them:

- The **run tree is the demand graph** — runs cause runs (`origin.causedByRunId`), and each causal layer
  multiplies demand. This is where throughput is *generated*.
- **Placement is the supply graph** — Scheduler → Backends → runtimes/runners. This is where throughput is
  physically bounded, and where it *scales*: attach a runtime, pair a runner, let the autoscaler grow
  slots. Raising supply must never require touching the model.
- **Admission mediates.** Every run passes one gate; every caused run draws from its causer's envelope.

**5.1 One admission gate.** Admission of *any* run =
`envelope check (402) → tenant queue/concurrency caps (429) → fan-out guards (max children per run, max
causal depth) → class assignment`. The eval path already implements the first two (BudgetTracker.admit,
Scheduler caps); the gate makes them universal — an agent activation, a command run and a sandbox session
answer the same four questions before they exist. One gate means throughput *policy* has exactly one home,
which is what "extend and then close" means for execution: new kinds extend the ledger; none of them
reopens governance.

**5.2 Delegated envelopes along the causal tree.** The tenant budget is the root envelope. An agent run is
*activated with* an envelope — a delegated slice (the AgentSpec per-agent budget that agent-automation A7
left unenforced becomes exactly this). Every run whose `origin.causedByRunId` points into the tree draws
from its causer's envelope, and charges propagate to the root. The consequence is the property the
platform actually wants: **compute-blind demand, budget-bound spend**. An agent never reasons about
capacity — it may burst 500 runs if its envelope affords them, and the queue absorbs the burst — but it
structurally cannot spend what it was not delegated. Runaway fan-out stops being a policing problem
(cooldowns, dedup, depth caps as scattered per-engine guards) and becomes an accounting impossibility.

**5.3 Backpressure shapes; budgets bound; capacity scales.** Keep the born-queued discipline: demand is
never *rejected* for lack of capacity — it queues (WFQ keeps tenants fair, aging prevents starvation), and
the autoscaler + attachable runtimes convert queue depth into supply. Rejection is reserved for the two
honest reasons: the envelope is exhausted (402) or a queue cap is hit (429). This is the split that makes
throughput elastic: *slow* is a scheduling outcome, *no* is an economic one.

**5.4 Class rides the run.** `class = interactive | background | batch`. `CaseJob.priority` already
distinguishes a person waiting from a batch; the run record makes it uniform, and **agent-caused runs
default to `background`** — autonomous fan-out must never starve a human's click. The existing aging
guard keeps background/batch from starving in return.

**5.5 The causal tree is the kill switch.** Cancelling a run cancels its non-terminal descendants
(cascade, opt-out per cause); disabling an agent stops future activations. Large fan-out is safe to allow
*because* it is cheap to revoke — one cancel, not a hunt across N scorecards.

**5.6 The control plane is a ledger, never the executor.** Supply lives in tenant runtimes;
`placement: "inline" | "driver"` are bootstrap rungs (dev, small installs) with hard caps, never the
scaling path. Session runs (§4) occupy supply without progressing, so they draw from their **own cap
pool** — a held-open shell must not consume task throughput.

### 6. The data plane — own the record, adapt the edges

> **Direction upgraded (maintainer decision, 2026-07-29): see
> [native-observability.md](./native-observability.md).** This section's compromise — own the evidentiary
> copy, keep external platforms as *import* edges — was superseded: Everdict owns the trace domain itself
> (its own OTel-standard ingestion + tenant-scoped store); external platforms become egress **mirrors**
> plus import **compat shims**. The invariant below ("never judge what you don't retain") and the triad
> stand unchanged — the new design makes the invariant structural instead of maintained. The "external
> half is legitimate" argument narrows to *view*-legitimacy: their dashboards stay fed (collector
> fan-out), but the record is ours.

A run touches three data domains: it runs **from** an environment image, it **records** a trajectory, and
it **produces** outputs. Two of the three have settled their ownership: the workspace filesystem owns its
bytes (bucket-per-tenant, revisions, actor attribution) and the image store now owns its bytes too
(managed store, token-server isolation — [managed-image-store.md](./managed-image-store.md)). The third —
the **trajectory** — is the least controlled domain in the platform, and it is the one every judgment
stands on.

**The trajectory has seven spellings today.** Inside one `CaseResult` alone: `trace` (the TraceEvent[]
embedded in the row), `traceRef` (a control-plane collection target for two-phase pull), `evidence`
(slots extracted from a pulled trace), and `recordingRef` + `envDeltas` (the sealed replay planes).
Outside it: the tenant's external platform spans (what Settings › Traces browses and chips point into),
`LiveTraceRef` (a deep-link that is *"present only while the run is observable"* — an explicitly decaying
pointer), agent transcripts (messages in the session store, not TraceEvent), and the live-log evidence
fallback for trace:none harnesses.

**Why this domain is harder than files or images: the external half is legitimate.** A tenant's
Langfuse/MLflow *is* where their organization looks at traces — absorbing that domain (the 037 move)
is neither possible nor desirable. But the current design lets the external platform be the **system of
record** in places: pull-ingest attach-mode writes our scores onto *their* trace; browse/inspect surfaces
read *their* store; deep links dangle when *their* retention policy fires; export is best-effort by
design (correct — but that means the external copy is never guaranteed). Register-time `probe` tells us
the connection worked *then* — the same decayed-truth disease `verifyImage` had. Add the storage smell —
traces ride as row embeds so heavy that `ScorecardStore.list` must omit them — and the asymmetric ledger
(export outcomes are recorded on `ScorecardRecord.export`; imports have no uniform provenance stamp), and
"제어가 안 되는 수준" is exactly right.

The ownership move here is therefore different from 037: **own the evidentiary copy; demote every
external platform to a declared edge.**

- **TrajectoryStore** — an owned, offloaded store (object storage, tenant bucket: the filesystem's
  isolation grammar). `Run.trajectory` becomes a **ref**, never a row embed. Append-only while the run
  is live (the log tail and the chat panel read the same stream), **sealed at terminal status** — the
  recording's fold-and-seal pattern (`envDeltas` fold into the recording at seal, then clear) generalized
  to the whole trajectory. Planes on one clock (replay.md's t0): **events** (TraceEvent, semantic),
  **tracks** (recording, sensory), **deltas** (environment). This is also what makes P5 (agent
  transcript = trace) physically storable, and it removes the last CP-as-data-plane violation (§5.6).
- **The invariant: never judge what you don't retain.** Import = materialize first — a pulled trace is
  copied into the TrajectoryStore, and judges run on **our copy**; the external id stays as provenance;
  attaching scores back to their platform remains a best-effort *export*. Today ingest half-holds this by
  accident (the pulled TraceEvents end up in the record embed); the invariant makes it a stated rule, so
  no tenant retention policy can ever delete the evidence under a verdict.
- **A symmetric sync ledger.** Export already records its outcome (status/link/per-case external id, mig
  0048). Imports get the mirror: every materialized trajectory carries `{source, externalId, pulledAt}`.
  Both directions auditable; neither direction the record. Sync operations are **edge operations with
  outcome records, not runs** — do not runify them.
- **Pointers are UX, copies are evidence.** `LiveTraceRef` and deep links stay — they are how a person
  jumps to the platform their team lives in. But nothing evidentiary (a judge verdict, a scorecard
  aggregate, a knowledge claim) may rest on a pointer.
- **Normalization stays at the border.** Platform quirks (MLflow 3.x paths, OTLP shapes, per-kind attach
  support) live only inside `packages/trace` adapters; `TraceEvent` is the boundary contract. Already
  true — now stated as an invariant so it survives the next adapter.

**The triad, one grammar.** What 037 did for images and the filesystem did first, the TrajectoryStore
completes:

| | image store (FROM) | trajectory store (HAPPENED) | workspace fs (PRODUCED) |
|---|---|---|---|
| canonical | owned (token-server isolation) | owned (tenant bucket) | owned (bucket-per-tenant) |
| external edge | BYO registry = adapter | trace source (import) / sink (export) | — (presigned artifacts out) |
| immutability unit | digest | sealed trajectory | revision |
| attribution | publisher | the run | actor (member/agent) |
| joined by | `subject.image` + `placement` | `trajectory` (ref) | `outputs.files` |

Every kind maps onto the triad: an eval run consumes an image, seals a trajectory, deposits outputs; an
agent run seals its transcript-trajectory and publishes files; a command run consumes an image and reads/
writes the fs; a sandbox session seals the trajectory of what was done inside.

### 7. Why this makes agents able to analyze runs

Symptom 2's fix is not a feature, it is the consequence of the model: once every execution is a Run with a
trajectory, outputs, a group, a cause and a lineage, the agent's read surface (`get_run` / `list_runs`,
already MCP-exposed) becomes the substrate. "Compare the last five experiments on this harness", "what did
the nightly agent actually change", "which runs did this event cause" are all list+filter queries against
one table instead of joins across two services. Comments already accept `run` as a resource type, so a run
can be discussed like any other entity, and the knowledge layer can promote what was learned.

## What each existing thing becomes

| Today | Becomes | Migration |
|---|---|---|
| `RunRecord` (harness+case) | `Run{kind:"eval"}` | additive columns; existing ones stay |
| `ScorecardRecord` | `RunGroup{kind:"scorecard"}` + `scoring` | record kept; group semantics layered on `runIds` |
| — | `RunGroup{kind:"experiment"}` | new (phase-1-only fan-out) |
| `AgentSessionRecord.status/origin` | `Run{kind:"agent"}` | session keeps **messages**; `runId` links them |
| Agent fleet (`/agents`, agentPlane) | a filter on the activity console | fleet view becomes `kind=agent` |
| `agent.run.*` events | `run.*` with `kind` | one family; keeps the "not trigger-matchable" rule |
| `POST /fs/executions` result | `Run{kind:"command", placement:"driver"}` | the result becomes the run's outputs; placement can move to `runtime` unchanged |
| — | `Run{kind:"sandbox", lifetime:"session"}` | new: bring an environment image up and shell in |
| `BrowserSessionService` (own record/API/page) | `Run{kind:"sandbox", attach:["cdp","screen"]}` | TTL + per-tenant caps + reaper generalize as-is |
| `/runs/:id/exec` · terminal ticket · screen | `attach` channels on any run that has them | routes stay; they stop being eval-only |
| Scheduled analysis report | `Run{kind:"analysis"}` | `report.completed` stays the fact |
| Schedules / CI / agent triggers | three subscriptions, one output | engines untouched; they create Runs |
| `CaseResult.trace` row embed | `Run.trajectory` → TrajectoryStore ref | dual-read; new runs write refs (O10) |
| pull-ingest (attach mode) | materialize-then-judge + best-effort attach-back | the invariant; external id = provenance |
| `ScorecardRecord.export` | the export half of the symmetric sync ledger | unchanged; imports gain the mirror stamp |
| recording (`recordingRef` + `envDeltas`) | a plane of the sealed trajectory | siblings first, one seal later (O9) |

## Phasing (each additive and shippable on its own)

> **Sequenced by [execution-master-plan.md](./execution-master-plan.md)** (plan of record — waves W0–W7; decisions locked at recommended values).


- **P0 — Run gains its shape.** `kind` (default `"eval"`), structured `origin` (superseding the free-string
  `trigger`), `class`, `envelope` (stamped, not yet enforced), `outputs`, `lineage`, `group`,
  `placement`/`lifetime`/`attach`. One migration; eval runs keep their columns, so no existing surface
  moves. The activity console starts rendering per-kind rows.
- **P1 — Experiment (phase 1 alone).** A group of ungraded runs over an ad-hoc task or a dataset; harness
  detail gets "Try it". No scoring code touched.
- **P2 — Phase 2 detached.** `POST /groups/:id/score` applies judges/graders over an existing group's runs;
  scorecards call it inline. Re-scoring and "promote experiment → scorecard" fall out.
- **P3 — Agent runs enter the ledger.** The agent service writes `Run{kind:"agent"}` transitions (control
  plane owns the record — O4); the session keeps the transcript and gains `runId`; the fleet view becomes
  a filter on the activity console. `causedBy` stamping starts here (an agent-submitted scorecard carries
  the agent run's id). **Both openings are wired** (O1): an activation woken by an event opens a
  background, event-caused run, and a chat turn a member types opens an *interactive, member-caused* one —
  same ledger, same settle, same sealed transcript-trajectory, grouped by the conversation. The bridge is
  one endpoint (`POST /internal/agent-run-events`, `cause: event | chat`); chat turns deliberately do NOT
  land on the event log — `agent.run.*` exists so *headless* work is visible, a conversation is already
  visible as itself, and human typing volume would drown the log. Not yet on the ledger: comment-thread
  discussion turns (their own surface reports live activity — folding them in is a separate decision).
- **P4 — Governance: the gate and the envelopes.** The one admission gate in front of every kind; delegated
  envelopes enforced along the causal tree (the A7 per-agent budget becomes the agent run's envelope);
  fan-out guards; cascade cancellation. This is the phase that makes agent-scale fan-out *safe to allow*.
- **P5 — Trajectory store + unification.** The owned TrajectoryStore (ref on the run, sealed at terminal
  status, materialize-on-import); agent transcripts persist as `TraceEvent[]` (dual-write first). This is
  what puts agent runs inside judges, trace sink, replay and analysis — and takes traces out of row embeds.
- **P6 — Session runs.** `kind:"sandbox"` ships as "run this environment image and shell in", reusing the
  existing exec/terminal/ticket routes; reaper + session cap pool + idle metering. Browser sessions fold
  in behind their current API later (O6). **First rung SHIPPED (master-plan W5)**: `SandboxSessionService`
  — the record on the universal ledger (`Run.newSandboxSession`: born running, `session{image,ttlSec,
  expiresAt}` ON THE ROW, mig 0099), only the live `ComputeHandle` in a process-local map (the
  BrowserSessionService split); provision-before-record (no orphan rows), dispose in a `finally` on every
  path, per-tenant/global caps (429), every exec appended to the session trajectory and sealed at teardown
  (`GET /runs/:id/trajectory` serves it — no new read surface). Surfaces: `POST /sandboxes` /
  `…/:id/exec` / `…/:id/close` + `create_sandbox`/`sandbox_exec`/`close_sandbox` (opt-in:
  `EVERDICT_SANDBOX_DRIVER=docker`). **The durable reaper also SHIPPED (T-b)**: `sessionReaperWorkflow`
  (`everdict-reaper-<runId>`) started at create, signalled on close, deadline → the internal reap bridge —
  a CP dying with the live handle no longer leaks: the row's `session.computeId` lets `Driver.reap` remove
  the stray container and the ledger settles `orphaned` (see docs/orchestration.md item 2). **The harness
  playground also SHIPPED on this rung**: `POST /sandboxes {harness}` boots a REGISTERED harness into the
  session (warm-install-before-record) and `…/:id/tasks` drives ad-hoc test cases through it one at a
  time, each its own grouped child run with a live trace cursor — the interactive half of the P1 symptom
  ("a harness cannot be experimented with"), on the session machinery instead of a cold dispatch per try.
  See [harness-playground.md](./harness-playground.md). Remaining rungs: the WS terminal
  (`ExecStreamHandle` over `DockerComputeHandle`), idle metering (O5), private-registry pull auth, and the
  O6 browser fold.
- **P7 — Subscriptions converge.** Schedules emit `schedule.fired`; the three trigger engines converge on
  one subscription registry if the shape holds.

## Open decisions (maintainer input wanted)

- **O1 — Is a chat turn a run?** *Adopted: yes* — one turn = one run, grouped under the conversation.
  Uniform cost, status and trajectory; the chat panel becomes a live view onto a run rather than a separate
  world. Cost: run volume (mitigated by the grouping the console already does). SHIPPED in P3: the turn is
  `class: "interactive"` with `origin.cause: "member"`, so it is never scheduled like background fan-out and
  the ledger names who asked. The one narrowing taken at implementation: no `agent.run.*` event per turn
  (see P3).
- **O2 — Is an agent transcript a trace?** *Recommendation: yes*, this is what makes agent runs first-class
  everywhere. Risk: the trace contract was built for harness output; agent-specific fields (approvals,
  todos, sub-agents) may need extension rather than shoe-horning.
  **Shipped, with a correction the first drill found:** the transcript alone is NOT the whole trace. A
  transcript is chat protocol — it records what was said, never that a model was called or what it cost — so
  projecting it alone sealed evidence in which the agent typed and used tools but never called a model, and
  `usage` (the sum of `llm_call` costs) read zero for exactly the runs that spend money. The turn's own token
  counters now ride back with the transcript and close the stream as one `llm_call`; the agent counts tokens,
  the control plane prices them at seal (`priceUsd` — the meter's table, not a second one). A run whose evidence
  lives only in the trajectory store gets its `usage` from there on the detail read.
- **O3 — Does the group get its own record, or does `ScorecardRecord` generalize?** *Recommendation:
  generalize in concept, keep the table* — an experiment is a scorecard row with no scoring, presented
  under a different name. A new table forks the analysis/diff/leaderboard surface for no user-visible gain.
- **O4 — Who owns the agent run's lifecycle?** *Recommendation: the control plane owns the record, the
  agent service reports transitions* (it already reports the facts). The alternative — the agent service
  writing directly to the run store — is fewer hops but puts two writers on one ledger.

- **O5 — Does an idle session run burn the same budget as work?** *Recommendation: yes, metered by wall
  clock against the same per-tenant budget*, with a short default TTL (browser sessions' 15m is a good
  prior) and a visible countdown. A forgotten shell on a GPU runtime is the failure mode to design against.
- **O6 — Do browser sessions fold into runs now, or later?** *Recommendation: later* — ship `kind:"sandbox"`
  for environment images first, prove the reaper and the caps on a new surface, then migrate browser
  sessions behind their existing API. Folding both at once couples a working feature to an unproven one.

- **O7 — Envelope semantics: reserve or meter?** *Recommendation: meter with a headroom check* — admit
  while the envelope has balance, charge actuals at settle (exactly today's `admit`/`settle` pair,
  generalized). Reserving worst-case at admit would pessimistically lock out the bursty agents the model
  is supposed to enable. Cost: a tree can overshoot its envelope by the in-flight margin — bound it with a
  per-envelope in-flight cap.
- **O8 — Does cancellation cascade by default?** *Recommendation: yes*, over non-terminal descendants of
  the cancelled run, with per-kind opt-out; disabling an agent never retro-cancels finished work. A kill
  switch that only kills the root is not a kill switch.

- **O9 — Do recordings fold into the trajectory seal now?** *Recommendation: siblings first* — keep
  `recordingRef` beside the events plane and converge on one sealed unit once the store is proven. The
  shared-t0 contract already aligns them; forcing one seal on day one couples replay to a new store.
- **O10 — Backfill embedded traces into the store?** *Recommendation: no* — dual-read (ref wins, embed
  fallback), new runs write refs only. A backfill moves terabytes to change where old bytes sit; nothing
  reads them differently.

## Non-goals / guardrails

- **Not a workflow engine.** A run is an execution record with a cause, not a DAG node. Orchestration
  stays in the existing engines (Temporal for batches/schedules, the agent loop for agents).
- **Not a rename-everything refactor.** `scorecard` remains the eval vocabulary; the model underneath is
  what unifies. P0–P2 add capability without moving a single existing surface.
- **Not ungoverned autonomy.** Every run still passes RBAC, permission mode, budget and the loop guards;
  making agent runs first-class *increases* the auditability of automation, it does not relax it.
- **The control plane is never the data plane.** The record is a row; the trajectory offloads when heavy;
  execution happens on attached supply. If a design choice makes the CP do per-run work proportional to
  run *content*, it is wrong.
- **Not a hosting product.** Session runs exist to *inspect* an execution environment (verify an image,
  debug a failed case), not to host long-lived workloads. TTL, caps and idle metering are what keep that
  line; if a user wants a permanent box, that is their runtime, not a run.
- **Facts, not inference.** The platform records what ran and what came out; whether that is a regression
  or a flake remains a judgment made by judges and agents.
