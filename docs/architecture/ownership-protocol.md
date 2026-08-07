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

### Where this is enforced — and where it is not

Stated plainly, because a protocol that overstates its own coverage is the failure it exists to prevent.

| Site | Status |
| --- | --- |
| `assertIndependentVerification` (domain) | **enforced** — callers holding both assignments |
| Checkpoint persistence | **enforced where resolvable** — a `verifier` checkpoint whose producer is the actor that created the referenced run is refused |
| Verifier runtime | **absent** — no path spawns an agent in the verifier role |

Everdict has no verifier runtime today. Context separation — a verifier receives *evidence only*, never the
executor's trajectory or reasoning — is therefore a stated **principle**, not a live guard: there is no
spawn site to bind it to, and writing one so the protocol looks complete would be a claim rather than a
check. When verifier-role work becomes spawnable, that spawn is the third enforcement site, and the context
it assembles is where the principle becomes code.

## The envelope

An autonomous task runs inside a `TaskEnvelope`: an allowed capability set (deny wins over allow), at least
one hard budget (an unbounded autonomous task has no decision boundary — `assertTaskEnvelope` refuses one
without), and a fixed vocabulary for the two ways a task ends badly.

- `stop.onBudgetExhausted: "halt_checkpoint"` — stop **and** leave a resumable checkpoint. Dying silently
  mid-task is the exact failure the envelope exists to prevent, so "keep going" is not a value the type offers.
- `escalation.onScopeExceeded: "refuse_and_replan"` — a refusal is data the runtime acts on, never a warning
  a loop can log and ignore.

The kernel (`packages/agent-runtime/src/kernel/loop.ts`) honors the envelope on every tool call and at every
turn boundary, and passes it **verbatim to sub-agents** — without that line a scoped parent could
`spawn_agent` its way out of its own scope.

## The checkpoint

A successor decides its next action from evidence references, not from the predecessor's prose. So a
`confirmedFacts` entry requires at least one `CheckpointRef` — the schema itself refuses a "fact" without
evidence, because a statement with nothing behind it *is* a hypothesis and the checkpoint has a field for
those. `danglingCheckpointRefs` resolves every reference against the real stores; a fact whose evidence
cannot be found is not a fact the successor can stand on.
