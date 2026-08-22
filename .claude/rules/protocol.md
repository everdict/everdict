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
  anything persisted.
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

## A COMMENT THAT PROMISES ANOTHER COMPONENT'S BEHAVIOUR IS A CLAIM, AND THE CLAIM NEEDS THE TEST
Three reviews in a row have found the same thing: a guard was written correctly, and the sentence justifying
it described what some OTHER function would do next — and that function did not do it.

- *"the caller already treats a throw here as 'not faithfully resumable' and leaves the batch for the next
  sweep"* — the caller caught everything into `false` and the sweep wrote a tombstone.
- *"the operation stays owed so a later sweep can decide with a readable ledger"* — the caller skipped the
  effect with no failure recorded and certified the operation published.
- *"the next sweep asks again"* — boot recovery ran once; the periodic reconcilers beside it were somebody
  else's.
- *"an ingest judges the pushed plane ONCE, so the pass id alone is the invocation"* — the judging site passed
  no pass id at all, so the evidence sealed under a different name than the receipt.

The shape is always the same: **the half that was implemented is the refusal, and the half that was written
down is the recovery.** A refusal is local and easy to verify; what the refusal BECOMES is three frames away
and nobody looks.

So, when a comment contains a promise about another component — "the caller handles", "the sweep retries",
"stays owed", "is retried later", "the next pass" — that clause is the part of the change that needs a
counterexample. Grep for the promised component before writing the sentence; if it does not exist, the change
is not done, and if it does exist, the test drives it rather than the guard.

## A PROOF IS BORN FROM THE SAME BUILDER AS THE EFFECT
L3 says provenance is born at the source. Attestation is where that law gets broken by people who believe they
are obeying it, because the request and the effect are both right there and copying the wrong one type checks.

    request copied into proof   ≠   native effect read back into proof

The Nomad lane computed `Resources.CPU` and `MemoryMB` from the case, computed `Devices` from the HARNESS spec
only — dropping `evalCase.resources.gpu` — and then stamped `withWorldProof(job, "nomad", job.evalCase.resources)`,
the WHOLE declaration, as what it had enforced. A case asking for one GPU got a task with no device request and
an in-container proof saying `gpu: 1` was applied. That is worse than the refusal it replaced: a refusal is
visible, and a false attestation makes the driver ACCEPT a world nobody provided and report the score as if
nothing had changed (arch-review 59 P0-world).

So: one function produces the native fields AND the proof, from the same inputs, and the manifest and the
attestation are two renderings of its single answer. If an axis cannot be rendered natively it is absent from
BOTH — `worldProofCovers` reads silence as "not enforced", which is the fail-closed direction.

The corollary bites in the other direction too. When a lane starts enforcing an axis, the proof must learn it in
the SAME change: K8s grew a deny-all egress NetworkPolicy while `withWorldProof` still refused to claim
`network` (and its comment still said no lane writes one), so every offline case applied the policy, started the
Job, and was then refused by the in-container check for lack of the proof. The feature was inert end to end and
every test passed.

## A SECRET IN A PROCESS'S INITIAL ENVIRONMENT IS NOT REVOKED BY A LANGUAGE-LEVEL DELETE
`delete process.env.X` changes this process's copy and what its future children inherit. It does not change what
`/proc/<pid>/environ` reports, which is the environment the process was EXECVE'D with, and it does not reach a
sibling that already inherited it. `clearenv()` moves pointers; it does not scrub the bytes.

Two consequences this repo has already paid for (arch-review 59 P0-security):

- Handing a credential to a narrower CONSUMER in TypeScript is not handing it to a narrower PROCESS. The judge
  key was moved from the driver wrapper to `runCase`'s `graderEnv` — correct, and inert on the managed lanes,
  because the backend puts `judgeAuthEnv` into the pod/task environment, so the job-runner already holds it and
  `LocalDriver` execs the agent with `{ ...process.env, ...opts.env }`.
- Taking a payload out of `process.env` after reading it bounds child inheritance and proves nothing about the
  initial environment the kernel still reports.

So a secret-bearing control envelope does not travel as an environment variable at all. The closure is a
transport the agent's process boundary cannot reach — a file descriptor, a one-shot socket, a separate UID — and
an EXPLICIT allowlist for what a child is exec'd with, never `{ ...process.env }`. Until that exists, say what
is actually true: "the agent no longer inherits it from us" is a different sentence from "the agent cannot read
it", and only one of them was earned.

## A LIFECYCLE STAMP NAMES AN OBSERVED FACT, NEVER AN INTENDED ONE
`executing` was stamped by the `onStarted` hook, and both managed lanes fired that hook BEFORE the external
object existed:

    reserve → activate → onStarted (→ executing) → ensureNamespace → NetworkPolicy → applyJob

So the ledger said a case was executing while nothing had been created, and the cancellation that reads state
to decide what may still be born read a lie. The teardown's birth guard covers `reserved` (revoke it) and
`active` (stay owed), and an attempt that had already been stamped `executing` fell through both — probe says
absent, certificate says zero, and the paused submitter then creates the Job (arch-review 60 P0).

The stamp was not wrong about the future; it was wrong about the tense. A state a guard consumes must be a
statement about what HAS happened, so:

- The transition that means "the effect exists" is written after the effect returns, not beside the intent to
  cause it. A hook fired at the top of a function names the function's start, which is not an event anybody
  outside this process can observe.
- **The set of states from which an effect may still be created is ONE exported list**, consumed by every
  guard. Spelling `state === "reserved" || state === "active"` at the teardown is a subset somebody has to
  keep in sync with a state machine that grows — and it grew, and nobody did. Adding a state to the machine
  must break the guard's compile, not silently narrow it.

## A TIME-BASED LEASE IS NOT A FENCE
An expiry says "the holder has probably died". It does not say "the holder can no longer act", and the two
differ exactly when it matters: a process paused past its lease wakes up holding an activation it was granted
and never re-reads, so revoking the row changes nothing it will look at. Adding an age comparison bought
liveness for the teardown and bought the submitter nothing (arch-review 60 P0).

A fence is read BY THE THING BEING FENCED. So an authorization whose revocation must actually stop an effect
needs one of:

- the holder re-proves at the moment of the effect (`requireActivation` immediately before the create — this
  narrows the window to one call, it does not remove it);
- the holder UNDOES its own effect when it learns the authorization is gone (create, re-verify, delete what
  it just made) — the shape available when the effect is addressable and reversible;
- the object is created INERT and a later transition makes it runnable, so a cancellation always has
  something to address and never has to reason about a birth that has not happened yet. **This is what the
  K8s lane does** (`suspend: true` → re-present the reservation → `suspend: false`), verified on a live
  cluster: suspended is zero pods, deleted-while-suspended is a pod that never existed, and a refused
  activation deletes what the dispatch made. A lane whose orchestrator has no inert form keeps the narrower
  order and says so — Nomad does — because claiming the stronger property without the mechanism is the
  failure this whole rule is about.

Clock skew is the smaller half of this and still real: an age computed from an application's `now()` against a
store's `updated_at` is two clocks. Say which one is authoritative, or compare within one.

## AN ADOPTED RESULT CARRIES WHICH STAGE PRODUCED IT
Adoption recovers an answer from work this process did not dispatch. When a case has two halves — the agent's
and the private verifier's — both are handles under one execution id, and a recovery that iterates handles and
takes the first `adopted` will take whichever answered.

`adoptedResultFrom` returned a `CaseResult` for both, because the verifier's scores had to reach a caller that
wanted that shape. The shell it built (`harness: "verifier"`, empty trace, empty snapshot) was documented as
"nothing persists this", and then `Run.adopt` persisted it: a run whose agent Job had been reaped settled
`succeeded` carrying the verifier's document as the case's whole evidence (arch-review 60 P0).

A value shaped like the final document IS the final document to every caller that does not ask. So:

- Adoption returns a **stage-tagged union** (`{kind: "case", result}` | `{kind: "verifier", invocation}`), and
  the settle path names the case it handles. A shell that type-checks as the outcome will be settled as one.
- A two-phase case makes its FIRST phase durable before starting the second, or a crash between them leaves
  the only copy of the agent's half in a dead process's memory and the recovery has nothing to merge into.
- "The caller only takes the scores" is a claim about a caller; write it as a type or it is a hope.

## Definition of done for a protocol change
1. The counterexample exists and was seen RED **for the stated reason** (see rule `testing`).
2. `pnpm protocol-mutations` neutralizes the new protocol in the production file and the owning suite goes RED.
   A mutation whose target line no longer exists FAILS — a deleted subject never silently stops being tested.
3. The escape hatch is deleted in the same change: the optional hook, the `void` writer, the boolean+optional
   pair, the allowlist entry. A migration that leaves both shapes alive asks every future caller to pick, and
   the call site never shows which one is safe.
