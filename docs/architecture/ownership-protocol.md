# The ownership protocol

Ownership as a **verifiable, transferable protocol** — not an imitated person. When a workspace hands work to
an agent, three questions decide whether the result is worth anything: what was it allowed to touch, when was
it supposed to stop, and who says it worked. The protocol answers each with a type, and each type with an
enforcement site.

- **`RoleProfile`** — what a role may touch and what "done" means for it.
- **`TaskEnvelope`** — the decision boundary an autonomous task runs inside.
- **`HandoffCheckpoint`** — a resumable state transfer, where facts carry evidence and everything else is a
  hypothesis that says so.

Contracts: `packages/contracts/src/records/ownership.ts`. Invariants: `packages/domain/src/ownership/`.

## Roles, and the actor behind them

The seven roles (`observer` · `diagnostician` · `planner` · `executor` · `verifier` · `operator` ·
`coordinator`) separate five things that get conflated into "the agent": role, context, capability, evidence,
and completion. Never *which model* — a bigger model is not a different accountability.

Two invariants hold **inside** a profile (`assertRoleProfile`):

1. `observer` / `diagnostician` / `verifier` write nothing. A verifier that can write is an actor.
2. Only a verifier completes with `verified_verdict`. An executor finishing produces a `change_set` — a
   **claim**, which someone else verifies.

Both are necessary and neither is sufficient, because a profile says nothing about who is wearing it. One
process can hold the executor profile, finish, then hold the verifier profile and pronounce its own work good
— every rule above satisfied, and the verdict worthless. So identity is its own type:

```ts
ActorRef      { id, sessionId?, runId? }   // member subject, or agent:<agentId>
RoleAssignment { profile, actor }          // the unit separation is stated over
```

`assertIndependentVerification(executor, verifier)` refuses a `verified_verdict` when the verifying actor **is**
the executing actor, or when the two shared one run or one session. The last clause matters as much as the
first: two distinct identities inside one execution context are not independent, because the verifier read the
executor's own reasoning on the way in.

### Context separation has no field, deliberately

`RoleProfile` used to carry `contextScopes: string[]` — "which provenance scopes this role's context may draw
from". Nothing ever read it, including `assertRoleProfile` two lines below it. It was removed rather than
wired, on two findings:

1. **There is no context-assembly point to filter.** Knowledge, memory and skills do not arrive as a
   pre-built bundle of classes an agent could be given a subset of; the agent *pulls* each one through a tool
   it decides to call (`get_task_context`, `use_skill`, `get_file`). The only thing injected unasked is the
   environment block — workspace, model, date, paths. There is no menu for a role to select from.
2. **The job it named is done by the envelope's scope.** "What may this role draw on" is *which tools it may
   call*, which is exactly `TaskEnvelope.scope.reads` — an evidence-only role gets an explicit read list, the
   default executor posture is `reads: "all"`. Both halves of the scope (`reads` AND `writes`) are honored by
   the kernel on every call (`authorizeToolInvocation` — the one decision function, executed verbatim) and
   inherited by sub-agents. A second vocabulary for the same concern, read by nothing, is not a weaker
   guarantee. It is a false one.

Verifier context separation stays a principle (above) until there is a verifier spawn site; `scope.reads` is
the field that spawn fills when it exists.

### Where this is enforced — and where it is not

Stated plainly, because a protocol that overstates its own coverage is the failure it exists to prevent.

| Site | Status |
| --- | --- |
| `assertIndependentVerification` (domain) | **enforced** — the ONE decision function (actor + run + session) |
| Checkpoint persistence | **enforced where resolvable** — the service assembles both `RoleAssignment`s from the referenced run's executor linkage and calls the domain function; missing linkage abstains |
| Verifier runtime | **absent** — no path spawns an agent in the verifier role |

Everdict has no verifier runtime today. Context separation — a verifier receives *evidence only*, never the
executor's trajectory or reasoning — is therefore a stated **principle**, not a live guard: there is no
spawn site to bind it to, and writing one so the protocol looks complete would be a claim rather than a
check. When verifier-role work becomes spawnable, that spawn is the third enforcement site, and the context
it assembles is where the principle becomes code. The DECISION that spawn must call already exists:
`assertEnvelopeForRole(profile, envelope)` (`@everdict/domain`) holds the delegation invariant — a role's
capabilities are the CEILING, the envelope's scope must be a subset (`reads: "all"` is delegable only by an
unrestricted-read profile; excess writes/reads refuse) — so a "verifier" envelope carrying production writes
stops typechecking its way into a runtime that would enforce exactly what it says.

Independence reads the **executor identity, never attribution**: `Run.origin.executor` records who performed
the work at creation (`agent:<id>` on activation and chat-turn runs) while `createdBy` stays the principal
the run acted as — the composition's `runActor` prefers the executor, which is what lets the same agent
filing from a *later* activation still be caught by the actor leg. And a VERIFIER checkpoint must declare
`by`: an anonymous verification used to make the whole independence check abstain — fail-open on the one
field the caller controls — and now refuses at admission.

## The envelope

An autonomous task runs inside a `TaskEnvelope`: a two-halved scope — `reads` ("all" = the executor posture,
or an explicit evidence-only list) and `writes` (the effectful capabilities explicitly granted), with
`forbidden` beating every grant — at least one hard budget (an unbounded autonomous task has no decision
boundary — `assertTaskEnvelope` refuses one without), and a fixed vocabulary for the two ways a task ends
badly. The scope decision has ONE owner (`authorizeToolInvocation`, contracts) and the kernel executes its
answer verbatim for both access kinds; kernel cognition tools (todo, plan, spawn, result paging, wait) are
`intrinsic` — part of how the agent thinks, outside the scope lists, still refusable via `forbidden`.

- `stop.onBudgetExhausted: "halt_checkpoint"` — stop **and** leave a resumable checkpoint. Dying silently
  mid-task is the exact failure the envelope exists to prevent, so "keep going" is not a value the type offers.
- `escalation.onScopeExceeded: "refuse_and_replan"` — a refusal is data the runtime acts on, never a warning
  a loop can log and ignore.
- `rollbackRequired` reaches the checkpoint boundary through the PRODUCER: envelopes are not persisted, so
  `publishHalt` carries the envelope's policy slice (`{id, rollbackRequired}`) in the checkpoint body and
  admission calls `assertCheckpointForEnvelope` — a rollback-demanding envelope refuses a planless handoff
  where the checkpoint is minted. Carrying the slice is stricter-only (omitting it is exactly the old
  behavior), which is why a caller-declared slice is safe. Both envelope AUTHORS run `assertTaskEnvelope` at
  their compose point (the activation's `envelopeFor`, the chat turn's scope completion) — the budget
  invariant fires where an envelope is born, not only in unit tests.

The kernel (`packages/agent-runtime/src/kernel/loop.ts`) honors the envelope on every tool call and at every
turn boundary, and passes it **verbatim to sub-agents** — without that line a scoped parent could
`spawn_agent` its way out of its own scope. A child's effective scope can therefore only shrink: it inherits
the parent's envelope, and the kernel builds its registry from the parent's *read-only* tools **filtered by
the parent's own scope** (a read-scoped parent must not hand a child the reads it was itself denied), so a
write the parent held has no door into the child at all.

### Who actually gets one

**Agent activations** (a platform event matching an enabled agent's trigger — `apps/agent/src/agent-activation.ts`).
That is autonomous work by definition: nobody is watching, and the boundary is the whole safeguard. The
envelope's id is the **run** id, because an envelope is per-execution and two concurrent activations must not
share a boundary. `role` stays absent — an agent spec declares no ownership role, and stamping `executor` on
it would be a claim the record cannot back.

**Interactive chat does not.** A human is present and asked for the tool call; refusing it would be the gate
misfiring, not working.

**Resumed legs are bound too.** An activation that parks for approval, or dies and is recovered after a
restart, comes back through `runContinuationTurn` — a new run on the ledger, and for a while an *unbounded*
one, which is the moment a long-running task is most likely to keep going. The continuation builds its own
envelope keyed on its own run id, so its budget starts fresh rather than inheriting a spent one: the ledger
says this is a new run, and per-run bounding is the same rule sub-agents already follow.

**Teammates do not, and that is the remaining gap.** `spawn_teammate` creates a persistent autonomous agent
whose standing task is seeded as its first message; `TeammateSupervisor` only serializes its turns. There is
no completion condition and no budget, which is precisely what `assertTaskEnvelope` calls "an unbounded
autonomous task has no decision boundary". A teammate's autonomy boundary today is consent at spawn time.
Binding one needs a decision this protocol has not made — what a teammate's *goal* and terminal condition
are — so it is named here rather than papered over.

Two seams are worth naming precisely:

- **Scope is completed where the tools resolve.** The activation states the boundary it owns (goal, budgets,
  vocabularies); `runChat` fills `scope.writes` with the write-capable tools of the built registry (and
  `reads: "all"` — the executor posture), because the agent's granted capabilities only exist as *names* once
  tools are constructed. Pinning them there is the point — a server connected mid-run is outside the scope
  the task was authorized under, not silently inside it. Narrowing writes below "everything granted" is a
  product decision (teammate bounding) deferred with it.
- **Budgets are the kernel's units, not dollars.** `spec.budgetUsd` is a different axis: the delegated slice
  governing work an activation *causes* (runs it submits, refused with a 402 at the admission gate, priced on
  the control plane). The loop measures tokens and wall-clock and knows nothing about money, so the envelope
  carries generous token/time walls (`ACTIVATION_TOKEN_BUDGET` / `ACTIVATION_TIME_BUDGET_SEC`) rather than a
  dollar figure nothing inside the loop could check.

### The halt writes the handoff

On `budget_exhausted` the **host** builds the checkpoint, not the agent — the agent is out of budget, and
asking it for one more turn to summarize itself is asking past the boundary that just stopped it. The host
states as *fact* only what it holds evidence for: the run, which is a resolvable reference on the ledger.
What the work achieved lives in a transcript the host never read, so it goes in `hypotheses`, where a
successor treats it as something to check rather than something to build on. Publication is best-effort by
contract: a control plane that refuses the checkpoint must not turn a bounded stop into a failed run, and the
halt is already a fact on the event log.

**The lifecycle says what the checkpoint says.** A halted run settles as **`suspended`** — on the session AND
on the universal run ledger — never `completed`: the checkpoint's own words are "the run halted before
reporting completion", and a status that contradicts them makes "done" and "stopped mid-task" the same claim.
The `agent.run.suspended` fact carries the handoff's actual fate (`published` | `failed` | `absent`), so
"resumable from a checkpoint" is only ever claimed when one landed. A turn parking on an **armed wait**
suspends the same way — waiting is not completion; the wake resumes it as a new run.

A **scope refusal produces no checkpoint**, and that is not an omission: `refuse_and_replan` returns the
refusal to the model as a tool result and the run continues. There is no halt to hand off from.

## Effect contracts, and the gate that reads them

A capability's `EffectContract` (`packages/contracts/src/records/capability.ts`) says what invoking it does to
the world outside the sandbox. `assertCapabilityEffects` has always refused to register a write-capable
capability without one. What was missing is the other half: **nothing read it at invocation time.** The agent's
permission gate classified risk by name prefix (`delete_` / `remove_` / `revoke_` / `unlink_`), which is a
guess about a string — `sync_inventory` looks benign and can bill a customer; `remove_label` looks alarming and
undoes itself.

`effectsRequireConsent` (`@everdict/domain`) is what reading it means. Four independent reasons to keep asking
a human even in auto mode, any one sufficient:

1. `sideEffect: "external"` — the one everdict cannot undo on the caller's behalf.
2. A workspace mutation whose `idempotent` was not **promised**. Absent is *unknown*, and unknown is not a
   smaller risk than declared-unsafe.
3. `rollback: { kind: "irreversible", requiresApproval: true }` — the author wrote the consent requirement
   down, and the gate reads it instead of inferring it from a verb.
4. `dataAccess.egress === "external"`. Orthogonal to `sideEffect` on purpose: a *read* tool that can reach an
   outside network is exfiltration-shaped, and `sideEffect: "none"` is a true statement about the wrong axis.

Provenance travels **with the tool**, not through a second lookup: the resolved capability stamps `effects` on
its `ToolDefinition`, the kernel hands it to the permission hook on the `PermissionRequest`, and the hook
classifies. The name lists remain authoritative only where nobody made a declaration at all — the built-in
control-plane surface and the kernel's own tools, which are ours and known rather than declared. Conversely a
declaration that says a tool is safe is **trusted over the name list**: that statement is what the workspace
signed up for when it adopted the thing.

Two deliberate non-additions:

- **`dataAccess` is not required by the registration guard.** An MCP server's spec cannot honestly answer it
  for a container it merely names, and demanding a declaration authors cannot make produces invented ones,
  which is strictly worse than an absent field.
- Prose `rollback` still parses. Every stored contract keeps working; the tagged forms are what a *machine*
  can act on, and the guard treats both as declared.

## The checkpoint

A successor decides its next action from evidence references, not from the predecessor's prose. So a
`confirmedFacts` entry requires at least one `CheckpointRef` — the schema itself refuses a "fact" without
evidence, because a statement with nothing behind it *is* a hypothesis and the checkpoint has a field for
those. `danglingCheckpointRefs` resolves every reference against the real stores; a fact whose evidence
cannot be found is not a fact the successor can stand on.

### Persistence and the surface

`HandoffCheckpointStore` (`packages/application-control/src/ports`, `everdict_handoff_checkpoints`,
migration 0137) is **append-only on purpose**: the port offers no update and no delete, so a predecessor
cannot rewrite evidence its successor already acted on. `CheckpointService` holds the two admission rules,
because both need to read *other people's* records:

1. **Dangling evidence is refused** (400). Resolvers are bound in the composition root for every ref type
   everdict can actually answer for — runs, scorecards, **issues and workspace files** are records we hold.
   A type with no resolver (`commit`, a foreign platform's `trace`) is **unverifiable, not false**: everdict
   does not host the tenant's git remote, and refusing a checkpoint for citing a commit would be pretending
   to a check nobody made. The tenant comparison lives in the resolver, so a checkpoint cannot prove a fact
   with another workspace's run. **What admission checked is stamped on the record**: each ref carries
   `resolution: "verified" | "unverified_external"` (set by the service, a producer-supplied value is
   overwritten) — "evidence-backed" and "evidence-VERIFIED" are different claims, and a successor weighing a
   fact reads which one it holds.
2. **A verifier does not check its own work** (400) — the O3 invariant, decided by the DOMAIN. The service
   resolves each referenced run's executor as an `ActorRef` (id + run + session context), builds the two
   `RoleAssignment`s, and calls `assertIndependentVerification` — actor AND run AND session independence,
   never a service-local re-implementation (which is how the check once silently narrowed to actor-id
   equality: a second agent id verifying from inside the executing session sailed through). Every clause is
   conditional on the linkage existing — no `by`, no role, or an unresolvable executor makes the check
   **abstain**.

Surface: `POST/GET /checkpoints` + `GET /checkpoints/:id`, and the MCP twins `publish_checkpoint` /
`list_checkpoints` / `get_checkpoint` — the transport an agent actually reaches this through, which is the
point. Authz reuses `agents:read` / `agents:write` (no new action). Creation emits `checkpoint.created` on
the E0 same-tx outbox, classified on the `agent` activity axis; it is deliberately **not** trigger-matchable,
because an agent waking on another agent's handoff is the runaway vector the `agent.run.*` family is
excluded for.
