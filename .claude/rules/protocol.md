---
paths: "packages/{contracts,domain,application-control,application-execution,backends,db,storage,registry,orchestrator,job-runner,self-hosted-runner}/**,apps/api/**"
---
# Protocol rules (push) — an identity is AUTHORITY, not annotation

Five laws. Each one was paid for by a shipped defect, and each defect was written by someone who had
already added the right noun — and then let the next step run without it. The case law (file, line, and the
wrong reasoning verbatim) is in skill `protocol`; read it before designing a new effect path.

The failure this rule exists to stop is NOT "a missing type". It is a correct type whose value is optional,
swallowed, re-derived, or advisory at the one seam where the next effect begins.

## L1 — Authority before effect
No external effect (cluster submit, sink call, spend, publish) until a store has **RETURNED PROOF** that the
effect's identity is durable.
- Computing a name is not reserving it. `UPDATE` returning is not a row changed. A callback resolving is not
  anything persisted. **Observing room is not reserving room**: `capacity()` is a probe, and between the read
  and the submit any number of other submitters read the same headroom and spent it. A limit enforced by
  reading it is enforced for exactly one caller at a time — which is never the shape that overruns it. An
  admission token is a value some store handed out and can hand out only once.
- **A persistence hook that no-ops when its id is missing LIES to its caller.** `if (!store || id === undefined) return;`
  inside a pre-effect hook reports success and the effect proceeds unrecorded. A caller that cannot record
  where the work will be must not get the work — refuse the dispatch.
- The shape that cannot be misused: the store returns a proof object and the effecting API **requires it as a
  parameter** — `submit(job, intent: PersistedWorkIntent)`, never `submit(job)` beside an optional
  `onReserved`. An optional hook is a request; a required parameter is a protocol.
- Every mutating store method a decision rests on returns evidence it happened (`… RETURNING`, affected-row
  count, the written row) — never `Promise<void>`. Zero rows updated is a THROW, not a success.
- Order is part of the contract: lifecycle flips (`running`) come after the reservation is durable, never
  before it.
- **A PROOF HAS A LIFETIME — the effect re-proves it is still valid, in the write that records the intent.**
  This is the half the first version of this law missed, and it is where the next review found the same defect
  class again. "The row exists" is not "the row is still authorized"; "the handle was persisted" is not "the
  parent is still open"; "a proof was returned" is not "it has not been revoked since". A reservation that
  checks only `WHERE id = $1` authorizes a *cancelled* execution's dispatch just as happily as a live one's.
  So the authorizing write is a CONDITIONAL transition, not a metadata update — one statement that asserts,
  together: the subject is in the state that may still act (`created`, not terminal/superseded), nothing has
  claimed it already (the work column is null), the owner's epoch is still current, and the parent/run it
  belongs to is still non-terminal. It transitions the row in the same transaction, so "authorized" is a
  state the ledger holds rather than a fact a caller remembers.
- Consequently a proof object is a **capability, not a receipt**: `submit(job, authorization)` where the
  authorization could not have been produced by a revoked actor. Two dispatches reaching one subject must not
  both succeed — the second is refused by the guard, or is the *same* dispatch by exact id (idempotent), never
  a silent last-write-wins on the column that names live compute.

## L2 — Unknown is unignorable
A read that failed is not an empty set, not `undefined`, and not "absent".
- Three-valued union (`ReadResult<T>` = `read | absent | unknown`, `@everdict/contracts`), consumed by an
  **exhaustive switch**. Banned: `.catch(() => [])`, `.catch(() => undefined)`, `.catch(() => ({}))` on any
  read a decision rests on; `?? []` after an awaited catch.
- **`{ value?: T; ok: boolean }` is banned.** A caller can consume the value and never look at the flag — and
  did, for a whole review cycle, while the flag's own comment explained why it mattered. A union cannot be
  misread; a companion boolean can.
- The three forbidden collapses, by consequence: a teardown that widens because it read nothing; an evidence
  read that falls back to the writer's clock; a fold over zero answers that certifies live work is gone.
- **A scanner with an allowlist is a design admission, not a solution.** Every allowlist entry is a place the
  type failed to say it. Prefer the union that makes the line unrepresentable; if you must allowlist, the
  entry states *why this caller does not decide* — and "re-dispatch only costs compute" is NOT a reason
  (a second physical attempt spends money, writes competing evidence, and re-fires external side effects).
- **NEVER SIGNAL `unknown` BY THROWING.** An exception is not a third value: it is caught by whatever generic
  handler is nearest, and it becomes THAT handler's meaning. A `throw` intended as "leave this for the next
  sweep" met `resume(...).catch(() => false)` one layer up and became "not faithfully resumable", which the
  layer above turned into a terminal `failed{INTERRUPTED}` — a transient ledger outage recorded as an
  evaluation that failed, permanently, in history. Return the union; make the caller name the case.
- **The union is not done until the CONSUMER CHAIN is.** Introducing `unknown` at the producer moves the
  question, it does not answer it. Walk every consumer to the point where a DURABLE decision is written and
  state what each does with the third case — including the fire-and-forget ones. A caller that returns
  `true` before its background work has decided has reported an outcome it does not have; the record is then
  claimed, `running`, and driven by nobody.
- The escape hatches that re-open this law, by name: `.catch(() => false)` on a resume, a `boolean` return
  where three answers exist, a `void (async () => …)()` whose failure nobody records, and `throw` as a
  signal. Each turns "we could not find out" into a decision somebody else made for you.

## L3 — Provenance is born at the source
Identity is recorded where it is produced. Never re-derive it downstream from rendered output.
- Banned re-derivations: metric name → judge id; latest row → winner; timestamp → canonical attempt; current
  carrier → an older settlement's payload; log text → outcome.
- Receipts are minted at the invocation/commit point and carry the coordinate the emitter carries, so the
  join key is the same object on both sides.
- **A predicate written twice has already diverged.** One owner, exported, imported. Before writing a
  string-splitting or classifying helper, grep for the concept — the correct version usually exists.
- Provenance states COVERAGE, not merely presence: `expected` vs `recorded` units, and `complete`. An empty
  receipt vector is not proof of authorship; a consumer that only asks `kind === "recorded"` accepts zero.

## L4 — A settlement owns immutable bytes
Everything a decision references has that decision's identity.
- A settlement stages its payload as an **immutable object (key + digest)** and the operation carries the key.
  It never re-reads "the record's current results" at drain time — a legitimate re-score then makes the older
  owed effect permanently impossible.
- A mutable "current" alias is a **monotonic projection with a revision guard**, never an ordinary effect of an
  independent operation. Two independent operations completing out of order must not move `current` backwards.
- An at-least-once external effect carries an **idempotency key in the PUBLIC contract**, typed all the way to
  the adapter, and the adapter derives deterministic external ids from it. A key that dies at a composition
  seam is worse than no key: the comment at the source says it travelled.
- A lease held across an external call is renewed while the call runs, or the lease is not a fence.

## L5 — Completion is verified zero
"The delete was accepted" is not "it is gone". "The lease was signalled" is not "it was revoked". "Terminal
child rows" is not "the container exited".
- Completion is a READ-BACK of zero: active managed work, live leases, queued intents, running workflows,
  non-terminal children, **and zero unknown reads**.
- **One verifier, one durable wrapper**, shared by the request path AND the reconciler. A sweep that calls the
  teardown directly and records a bare failure is a second protocol, and the two drift.
- "We could not find out" is an ESCALATION FIELD (attempts, backoff, operator alert) — never a terminal state
  that removes the debt from the sweep. Terminal means verified.
- **A DEBT OWNS ITS WORKLIST.** The law above says "terminal rows are not an exited container", and the first
  version of it still let the teardown DERIVE what to stop from those rows: it iterated the children that were
  still `running`, killed each one's work, and settled the row terminal whether or not the kill converged. So
  the first attempt recorded a failure and kept the operation owed — and the retry, iterating the same way,
  skipped every child it had just terminalized, found nothing live, and CERTIFIED completion over compute it
  had never confirmed was gone. The debt evaporated because it was stored in the subject's status rather than
  in the operation.
  So the operation holds an explicit workset — the exact handles, leases, queued intents and workflow ids —
  built from the ledger that records what was PLACED, not from what is currently open. Each item stays owed
  until it is independently observed absent. Row lifecycle and work lifecycle are different clocks; a
  cancellation converges on the second one.
- A read that fails while building that workset makes the operation `verifying`, never a shorter worklist.
  A teardown that could not enumerate what it owes has not enumerated zero.
- **Cancellation is also a REVOCATION** (see L1): after it, the subject may no longer authorize new external
  work. A stop that races a dispatch and loses is a teardown that will never converge.

## Corollaries — each one a law that was broken in a new place
The five laws are the whole contract; each line below is a place they were broken after being written, and
the heading IS the lesson. The incident, the wrong reasoning and the shape that holds are in skill `protocol`,
`.claude/skills/protocol/references/corollaries.md` — read the section before designing against it.

- A measurement is not evidence until something has passed it.
- A comment that promises another component's behaviour is a claim, and the claim needs the test.
- A proof is born from the same builder as the effect.
- A secret in a process's initial environment is not revoked by a language-level delete.
- A lifecycle stamp names an observed fact, never an intended one.
- A time-based lease is not a fence.
- An adopted result carries which stage produced it.
- A phase added to an object's life is a new arm for every reader of that object.
- The same call sequence is not the same effect semantics.
- Tightening a guard and moving a caller past it are one change, not two.
- A value the consumer never received — machine-checked, because prose did not hold.
- An optional dependency with no producer is a plan, and its test is a drawing of one.
- An atomic seam is selected by the effect, never by which rider happened to come first.
- An authorization and its effect must read the owner once.
- A refusal after an irreversible write is not a refusal.
- A join that owns one ordering owns nothing.
- A physical attempt's terminal is not the case's terminal.
- A schema split stops at the field you were thinking about.
- A policy is read from the policy, never from the data it judges.
- An entity has one owner, or the gate and the write are about different things.
- A lane that did not exist when the lesson was paid for still has to learn it.
- A refusal belongs to the function that answers, not to the one that renders the answer.
- A comment claiming a state is addressable is a claim about a transport.
- A fix can create the next defect by closing the louder half.
- A callback that ran is not bytes that landed.
- A policy that exists is not a policy the deployment chose.
- Canonical truth and cleanup eligibility are born together or not at all.
- Every ending releases its own refs, and a loser may not reopen a winner's debt.
- A planned write is not a written artifact.
- A constructed capability is not a delivered one.
- A sub-step's terminal is not the canonical terminal.
- A host-keyed rendering collapses repository-scoped grants.
- A double that always succeeds is not a store.
- A law is applied where a call site is written, not where a rule is read — each law broken by its own author one wave later was invisible at that site.
- Retention and deletion are two states, not one.
- "A receipt exists" is not "my result is the one that committed".
- A guard narrowed by a predicate owns the values it keeps.
- A logical write is as atomic as its statement count, and a green engine cannot say otherwise.
- A conditional write inside a transaction is not a successful one.
- An artifact without an operation is bytes nobody will look for.
- A measurement document is not a place to put platform control state.
- A content-derived address is not content authentication.
- An inline cleanup after a commit is not a lifecycle.
- The document that becomes durable is the document that is returned.
- Two contributors cannot be one coordinate.
- An intermediate artifact's window ends at the settlement, not at the step that used it.

## Definition of done for a protocol change
1. The counterexample exists and was seen RED **for the stated reason** (see rule `testing`).
2. `pnpm protocol-mutations --only <the rung>` neutralizes the new protocol in the production file and the
   owning suite goes RED. A mutation whose target line no longer exists FAILS — a deleted subject never
   silently stops being tested. ⚠️ This is no longer enforced by a gate (removed from `ci:local` and CI on
   2026-08-29 — a full pass is ~90 minutes and it dominated every iteration), so it is the AUTHOR who runs
   it. `--only` takes seconds; nothing checks that you did. A rung added without ever being driven is the
   vacuous certificate this whole file exists to refuse, and it is now cheap to avoid and easy to skip.
3. The escape hatch is deleted in the same change: the optional hook, the `void` writer, the boolean+optional
   pair, the allowlist entry. A migration that leaves both shapes alive asks every future caller to pick, and
   the call site never shows which one is safe.
