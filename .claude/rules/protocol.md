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
- *"connected-but-busy runners keep it fresh via their heartbeat, exactly like the in-memory hub"* — the store
  lane's idle timeout reads a per-JOB `activity_at`, and the only two statements that wrote it were keyed by
  `job_id`. Nothing refreshed a job still QUEUED, so a self-hosted job behind a long-running one was rejected
  "the runner is not connected, is idle/dead" while its runner was connected and working. The promised
  component here was an UPDATE statement, and the tell was one lane taking the argument as `_capabilities`
  while its twin used it (arch-review 119).

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

## A PHASE ADDED TO AN OBJECT'S LIFE IS A NEW ARM FOR EVERY READER OF THAT OBJECT
The previous review closed a birth race by giving external objects an INERT phase — a K8s Job at
`suspend: true`, a Nomad job at `Count: 0`. It exists, it is addressable, it runs nothing. That was the right
mechanism and it was verified on live clusters. What it was not is a phase anybody else had been told about.

`AdoptOutcome` says `adopted | absent | unknown`. Boot recovery holds the durable handle, finds the object
present, and calls `waitForJob` — and a suspended Job does not finish, so the wait times out into `unknown`,
which is `retry_later`, which is the same answer on the next sweep and every sweep after it. No owner resumes
it, no transition removes it, and the dependents (Secret, NetworkPolicy) stay with it. A phase the writer
introduced and no reader can name is not a state; it is a leak with a comment (arch-review 62 P0).

    the object is born inert   ≠   every owner of that object can recover it

So, when a change gives an object a phase it did not have:

- **Enumerate the readers before the writers.** Adoption, cancellation, probing, reconciliation, the
  operator's view — each one folds the world into its own vocabulary, and a vocabulary with no word for the
  new phase does not fail loudly, it MISFILES. `unknown` is where a misfiled phase lands, and `unknown` is
  designed never to be terminal, so the leak is permanent by construction.
- **The new arm carries what makes it decidable.** `inert` is not merely "not running": it is *nothing has
  been spent*, which is precisely why re-driving after reclaiming it is safe where re-driving an `unknown` is
  a double-spend. That difference is the whole reason the arm earns its place — an arm that only renames
  `unknown` has moved the problem.
- **Reclaiming is still L5.** Answering `inert` after a delete that was not confirmed is a certificate over
  compute you did not observe gone. Delete, read back, and answer `unknown` when the readback did not.

## THE SAME CALL SEQUENCE IS NOT THE SAME EFFECT SEMANTICS
Both managed lanes end up spelled `create inert → activate → start`, and a test asserted exactly that order on
both, and both were green. They do not mean the same thing:

    K8s   start = PATCH an existing Job   → a deleted Job makes the patch FAIL
    Nomad start = POST /v1/jobs           → a deleted job is silently RE-CREATED, and runs

So a cancellation that revoked the reservation, deleted the job, probed absent and certified zero was followed
by the paused submitter's start call bringing the job back — the exact race the inert phase was introduced to
close, reopened one call later on one lane only (arch-review 62 P0).

- **An order assertion is not an effect assertion.** `expect(order).toEqual([...])` pins the sequence and says
  nothing about what each call DOES to an object that has changed underneath it. The counterexample that finds
  this has to mutate the world between two steps — delete the object after activation — and then assert what
  exists, not what was called.
- **A write that can also create is not a transition.** Where the orchestrator offers a version fence
  (Nomad `EnforceIndex` + `JobModifyIndex`, K8s `resourceVersion`), the second phase carries the version the
  first phase returned, so "the object I am starting" is the object this dispatch made. Where it does not, the
  lane may not claim the transition — see the lease law above: claiming the stronger property without the
  mechanism is the failure, not the workaround.

## TIGHTENING A GUARD AND MOVING A CALLER PAST IT ARE ONE CHANGE, NOT TWO
Two changes, each correct, each with its own counterexample, each shipped green:

- `committed` was made to require that the parent is still open — a verdict may not claim a settlement that
  already closed without it.
- the standalone recovery was made to stamp `committed` AFTER the settle, so the attempt does not claim an
  answer the run has not recorded.

A successful settle makes the run terminal. So the stamp now runs when the parent is by definition closed, is
refused every time, and every successful recovery leaves its attempt `reserved` — the exact defect the wave
before had closed. Neither change is wrong. Their COMPOSITION is, and nothing in either change's own
counterexample could see it (arch-review 63 P1-high).

So when a change tightens a precondition, the change is not done at the guard:

- **Walk every caller, and specifically every caller some other change MOVED relative to that guard.** The
  dangerous pair is a guard that got stricter and a call site that got later — each reviewed alone, each
  fine alone.
- **State the guard's precondition as a question about the world at the moment of the call**, not as a rule
  about the row. "Is the parent open?" and "is this the result the parent settled with?" are different
  questions, and after a settlement only the second one has an answer.
- The suite cannot catch this with two separate tests. The counterexample has to drive the two changed
  things in the order production runs them, against the real store.

## A VALUE THE CONSUMER NEVER RECEIVED — MACHINE-CHECKED, BECAUSE PROSE DID NOT HOLD
Three reviews in a row found the same defect wearing a different coat:

    62   a producer fix that never reached its consumer
    64   an optional dependency with no producer at the composition root
    65   const dispatched = { ...job, registryAuths: [...] };   dispatchVerifier(job)

The last one is the shape at its purest: the enriched job was built, correct in every detail, and the
ORIGINAL identifier was passed one line later. The mint was right, the union grant was right, and the backend
— which builds its pull Secret from `job.registryAuths` — received nothing. A private runner image beside a
public task image sat in ImagePullBackOff with the CASE wearing our wiring error.

Two prose laws already covered it and neither bound. So `noUnusedLocals` is ON (`tsconfig.base.json`), and
turning it on found, in one sweep: this dispatch, two dead private methods whose comments describe careful
semantics nobody executes (`baselineAnchor`, `assertSession`), a dead store READ (`priorScoring` — a wasted
round trip and a dropped check), three dead trace-source helpers implementing an artifact channel with no
consumer, and a computed `targetRevision` whose comment explains a protocol that never runs.

- **A local that is computed and never read is invisible to review and free for the compiler to catch.** If
  you find yourself writing "the value travelled", the compiler can check it — ask it.
- The corollary for enrichment specifically: **name the enriched value and pass THAT**, never re-mention the
  input. `f(job)` and `f(dispatched)` differ by one token and by everything.
- A deliberate compile-time assertion (a drift guard, `AssertAssignable<A,B>`) is EXPORTED rather than left
  as an unused local, so the check and the guard coexist and the invariant is named on the surface.
- ⚠️ `pnpm typecheck` can PASS over a tsconfig change because turbo serves a cached result. When a compiler
  option changes, verify with `npx tsc --noEmit` inside a package before believing the gate.

## AN OPTIONAL DEPENDENCY WITH NO PRODUCER IS A PLAN, AND ITS TEST IS A DRAWING OF ONE
The wave that wrote the always-succeeds-double law below also shipped this, as the fix for a ledger that
claimed a refused verdict had contributed:

    // VerifierPassDeps
    attempts?: Pick<ExecutionAttemptStore, "transition">;
    …
    await deps.attempts?.transition(verifierAttempt, "superseded").catch(() => undefined);

`VerifierAwareDispatcher`'s constructor is `(inner, dispatchVerifier, agentHalves)`. There is no parameter to
pass a ledger through, so `deps.attempts` is `undefined` in every production dispatch and the correction is a
no-op — while its counterexample, which hands `withVerifierPass` a deps object of its own making, passes
(arch-review 64).

An optional dep is the shape that makes this invisible. A REQUIRED one fails to compile at the composition
root, which is the whole reason L1 prefers a required proof parameter to an optional hook; declared optional,
the missing wiring is indistinguishable from a deployment that legitimately has no ledger.

- **A capability a protocol depends on is REQUIRED at the seam that decides, or its absence is a named,
  tested outcome** — never a silent `?.` that reads as success.
- **A counterexample for a protocol drives the PRODUCTION COMPOSITION**, not the helper with a hand-made deps
  bag. The helper's test proves the helper; only the composition proves the wire. Where the composition root
  is too big to construct, the test asserts the constructor SIGNATURE carries the dependency — a fixture
  cannot pass what production has no parameter for.
- Grep for the producer before writing the consumer. `deps.x?.y()` with zero production writers of `x` is
  dead code wearing a comment.

## AN ATOMIC SEAM IS SELECTED BY THE EFFECT, NEVER BY WHICH RIDER HAPPENED TO COME FIRST
arch-review 70 gave the settlement a `CleanupRelease` rider so the release could ride the transaction. The
seam that chooses the transactional path was left as it was:

    if (opts?.stamp !== undefined && store.settleWith !== undefined)   // ← the ATTEMPT rider, only

The standalone cancel passes a release and no stamp. So the atomic path is skipped, `opts.release` is dropped
on the floor, the caller's `collect()` finds nothing freed, and the row stays `retained` — which `due()` never
returns. The fix for the leak was inert on every deployment with a real Postgres, one wave after it shipped
(arch-review 71 P1).

    a rider exists   ≠   this settlement takes the path that honours riders

- **The condition is "is there any effect that must be born with this decision", not "is THIS rider here".**
  A seam gated on one rider silently demotes every other rider added later, and adding the next one will not
  make anybody re-read the condition — it type checks, and the dropped field is optional.
- **When a second rider joins a seam, the seam's own predicate is part of the change.** Grep the condition,
  not just the call site.
- ⚠️ AND THE COUNTEREXAMPLE HAS TO USE A STORE THAT HAS THE ATOMIC METHOD. Mine did not: its double omitted
  `settleWith`, so the code took the non-transactional fallback — which DOES release — and the test passed
  over a production path it never entered. That is the adapter-divergence law below, hit while fixing
  something else. A double that lacks the method under test proves the other branch.

## AN AUTHORIZATION AND ITS EFFECT MUST READ THE OWNER ONCE
arch-review 77 closed a read-then-write window inside the WRITER: `registerPreservingOwner` stopped carrying a
team the caller had read and let the store resolve the current owner where the write happens. That is right,
and it moved the window rather than closing it, because the AUTHORIZER still reads the same mutable fact:

    route:     owner = teamOfEntity(registry, tenant, id)   → gate(principal, "agents:write", owner)
    …transfer: the entity moves from Team A to Team B
    effect:    registerPreservingOwner → resolves Team B → successor registered under Team B

The caller was authorized against Team A and the effect landed under Team B, which the caller may not write to
at all. Owner preservation succeeded; authorization is what did not.

    the current owner was preserved   ≠   the caller was authorized against that current owner

- **The effect carries the owner the authorization was granted against, as a PRECONDITION.** Not as the value
  to write (that is the read-then-write this replaced) — as an `expectedOwnerTeamId` the write asserts in the
  same statement that resolves the current one. A mismatch is a refusal, and the caller retries against what
  it can see now.
- **The same shape appears whenever a transport reads a fact to gate and a service re-reads it to act.**
  `POST /campaigns` reads the issue's team to authorize, then `CampaignService.open` reads the issue again to
  stamp the campaign's team; between them `POST /issues/:id/team` can move it, so a caller authorized for
  Team A files a Team B campaign. Pass what was read, and make the write conditional on it.
- **An entity with no TENANT-LOCAL owner is not an unowned entity.** `ownerOf` falls back to `_shared`, so
  `has()` answers true for a shared-only capability while `entityTeam` — tenant-local by construction —
  answers `undefined`. A campaign belonging to a private team then adopts a `_shared` candidate and mints a
  workspace-local version owned by NOBODY, visible to every other team. Where no local owner exists, the
  initial owner is the AUTHORITY that caused the write (the campaign's team), never silence.
- **Resolve-existence and local existence are two questions.** `has()` answers "does this name resolve here",
  which includes `_shared`; a workspace-local INSERT is a different fact. Reporting `created: false` from the
  first while performing the second tells an operator a version was proved when it was born.

## A REFUSAL AFTER AN IRREVERSIBLE WRITE IS NOT A REFUSAL
The adoption effect registered the candidate, read the document back, digested it, and threw on a mismatch.
Every one of those steps is right and the ORDER makes them worthless: registry versions are immutable, so
by the time the mismatch was found the label already held the wrong bytes — and the honest retry that
follows is refused by immutability, forever (arch-review 76 P0).

    proof authorizes D1 · label absent · caller submits C2
    register(C2) → readback D2 ≠ D1 → throw, operation stays `decided`
    honest retry with C1 → 409 immutable · this campaign can never be adopted

    the readback found a mismatch   ≠   the write did not happen

- **This is L1 in its plainest form, and it is easy to feel obeyed.** "Authority before effect" reads as
  satisfied when the check is *in the same function* as the effect. It is satisfied only when the check
  cannot be reached AFTER it. Ask: if this refusal fires, is the world exactly as it was?
- **Look for a write-free resolver before accepting write-then-verify.** Both lanes here had one — an
  agent's stored document is the parsed spec, a harness's is `resolveHarnessInstance(template, instance)`,
  a pure function the registry's own read composes. "We can only know after writing" is a claim to check,
  not a premise.
- **Where the effect genuinely cannot be previewed**, the write must be reversible (a staging namespace
  promoted on match) — and soft-delete is NOT reversal when the store refuses re-registration of a
  tombstoned label.
- ⚠️ **The test for this asserts the WORLD, not the refusal.** The first version checked "adoption threw"
  and "operation still decided", both of which stay true while the label is poisoned. The assertions that
  matter are `has(...) === false` afterwards and *the honest retry then succeeds*.

## A JOIN THAT OWNS ONE ORDERING OWNS NOTHING
Two durable facts have to meet: an adoption became `registered`, and its issue closed on that adoption's
proving scorecard. A consumer was written for `issue done → registered` and nothing owned the reverse. An
issue resolved BEFORE the registration produced one event, the consumer found the operation still `decided`
and skipped it, the E1 cursor advanced — and there is no second delivery of an event nobody rejected
(arch-review 76 P1-high).

The code's own comment said *"the next delivery re-reads it"*: a promise about a delivery that does not
exist. Comment-is-a-claim, with an event runner as the promised component.

- **Whichever fact lands SECOND performs the join.** Both writers check for the other; neither ordering is
  privileged. One shared predicate, consumed from both sides — written twice it has already diverged (L3).
- **An at-least-once cursor advances on success.** "The next delivery" only exists after a THROW. If your
  recovery story says "later", name the mechanism: a reverse consumer, a reconciler over the owed worklist,
  or a retry the handler actually triggers.
- The second-side join is best-effort by contract: the effect already landed, and an operation left owed is
  recoverable where failing a landed adoption is not.

## A PHYSICAL ATTEMPT'S TERMINAL IS NOT THE CASE'S TERMINAL
The legacy-retained sweeper folded `attempts.every(isTerminalAttemptState)` into "this execution is over".
`failed` means THIS attempt ended badly; `superseded` means another attempt owns the case. Both are terminal
for the ROW. The ledger exists to record several attempts per case, so there is always a window where every
attempt so far is terminal and the replacement has not opened — and collecting there deletes the retry's
artifacts (arch-review 76 P1).

- **A certificate over a logical unit reads the logical ledger.** The attempt row already carried
  `childRunId`; the child's status is the case's own outcome. Physical rows narrow the question, they do not
  answer it.
- **Fold fail-closed and in order**: any `unknown` wins, then any `live`, and only an all-terminal set is a
  licence. An attempt row that names no child answers `unknown`, not `terminal`.
- Same shape as L5's "terminal child rows is not an exited container", one layer up: the row's clock and the
  work's clock are different clocks.

## A SCHEMA SPLIT STOPS AT THE FIELD YOU WERE THINKING ABOUT
arch-review 72 found "a creation rule applied at decode time is a data outage" on the campaign FRAME and
closed it by splitting `CampaignFrameSchema` (create) from `StoredCampaignFrameSchema` (decode). The SAME
commit tightened two NESTED shapes and split neither:

    round.verdict.observations   gained REQUIRED assessed / eligible
    proof.candidate              gained a REQUIRED identity

Stored rows are parsed whole — `EvolutionCampaignRecordSchema` covers every round, and `list()` maps every
row through it — so one legacy round takes down a workspace's campaign list, and a legacy operation breaks
the adoption read added to make `decided` visible. Shipped, and pushed (arch-review 75 P1-high).

- **The split is a property of the ROW, not of the field you happened to name.** When a change makes any
  field required, list every schema that PARSES STORED BYTES containing it — including the ones that embed
  it — and ask each whether rows written yesterday still decode. `safeParse` a hand-written legacy literal;
  it takes a minute and it is the only evidence.
- **Two repairs, and choosing between them is the design.** Derive when the value is a RESTATEMENT of
  something already stored (`identity` is exactly `specDigest !== undefined`, the minter's own predicate) —
  normalize on read so the field stays non-optional and no consumer gains a third case. Leave ABSENT when
  the value cannot be derived from anything (`assessed`/`eligible`): a manufactured number is the evidence
  the policy exists to demand, invented.
- **And a row that may be READ may not produce new EVIDENCE.** The permissive decode is availability; it is
  not permission. A legacy campaign is still `open`, and a round logged after the upgrade BUILDS the
  held-out block the old frame could never have had — so the campaign regains the authority the new rule
  exists to withhold. Export the creation rule as a predicate (`campaignFrameDefects`) and consume it at
  every entry point that produces or consumes new evidence. Not in the pure gate: a total decision function
  may not depend on a schema version.

## A POLICY IS READ FROM THE POLICY, NEVER FROM THE DATA IT JUDGES
`minimumCoverage` was added so a frame could demand that some of a round was actually looked at. The check
was written inside the block that reads the data:

    if (obs !== undefined) {
      …
      const need = frame.observationPolicy.minimumCoverage;
      if (need !== undefined && …) return false;
    }

So a frame demanding 50% coverage was satisfied by a round carrying NO observations block at all — the
"an absence is not a clean bill of health" defect that same commit was written to close, reproduced by its
own fix one branch up (arch-review 75 P1-medium). Third occurrence of this shape.

- **Enter on the requirement, not on the evidence.** `if (need !== undefined) { if (data === undefined)
  return false; … }`. Data-first nesting silently exempts the case with no data, which is always the case
  the requirement was written for.
- The tell in review: a policy field read INSIDE a `if (value !== undefined)` guard. The policy did not ask
  about the value's presence; it asked for a level.

## AN ENTITY HAS ONE OWNER, OR THE GATE AND THE WRITE ARE ABOUT DIFFERENT THINGS
arch-review 118 gave the agent SAVE door a `teamOfEntity` gate. The CREATE door beside it — the same
registry, one file away — still called `teamForNew`, which answers "where does a NEW asset land". So:

    team-a owns helper@1.0.0 · a team-b member calls create_agent(helper@2.0.0)
    → no error · teamOfEntity(helper) = team-b · team-a can no longer write their own agent

Ownership is read off an entity's NEWEST version, so registering a successor under your own team takes the
whole entity over. Verified through the real MCP door before the fix (arch-review 119).

The same write is what let two ownership predicates diverge: the gate reads the newest version's team,
`registerPreservingOwner` resolves the OLDEST live one that has a team, and only a split entity can tell
them apart — so a caller authorized against team-b had its version filed under team-a, deterministically,
with no race at all.

- **Close it at the STORE, not at every door.** Sixteen transports had to be right and one of them was
  written after the lesson; the write itself has to be the seam. A `register` that would change an entity's
  owner is refused (a transfer is `moveToTeam`'s act, and it moves every version at once), and SILENCE
  preserves the owner rather than unowning the entity — an unowned capability is writable by every team,
  which is the same takeover with no name on it. Registering is not a way to disown.
- **Two readers of one fact is one reader too many.** Do not pick the "right" one; make the state that
  distinguishes them unreachable, and then neither reader can be wrong.
- **A guard you cannot drive is worse than no guard.** The first repair here threaded an
  `expectedOwnerTeamId` from the gate into the service — and once the store refused every re-file, and with
  no transfer surface on that entity, the precondition could never mismatch. It was removed and the route
  says why. An unreachable refusal is a claim that a window is closed, with nothing able to test it.

## A LANE THAT DID NOT EXIST WHEN THE LESSON WAS PAID FOR STILL HAS TO LEARN IT
The one-lane-only law says: after changing a guarded write's contract, grep every OTHER caller and count
them in the commit message. That instruction assumes the lanes all exist at the time. arch-review 74 found
the shape a NEW lane makes, which the counting cannot reach:

    saveAgent              teamId = the entity's own team    (learned in evolution review wave C)
    harness routes / mcp   owner.teamId
    harness re-pin         teamOfVersion (REQUIRED for it)
    campaign adopt         undefined                          ← written after the lesson, by its author

Ownership is read off an entity's NEWEST own version, so registering a successor with no team re-files the
whole entity out of its team's list the moment it becomes latest. Wave C paid for that, and the adoption
door — added three waves later, in the same repository, by someone who had read the fix — reproduced it
exactly, because there was nothing to grep: the lane was new.

- **A new call site of an old effect inherits every constraint that effect's other callers carry.** Before
  writing `register(...)` / `submit(...)` / `transition(...)` for the first time in a new module, read what
  the EXISTING callers pass and why. An argument that every other caller resolves and this one passes
  `undefined` is the finding.
- **The reusable answer is a named helper, not a remembered rule.** `teamOfEntity` already existed and is
  the single owner of "whose is this". A lane that hand-rolls the answer (or omits it) is a second spelling
  — and omission is the spelling nobody notices, because it type-checks.
- ⚠️ The gates cannot see this: `unwired-capabilities` asks whether an optional PORT has an implementation,
  and this is a required argument with a legal value. What catches it is reading the sibling call sites,
  which is why that instruction now leads with "read", not "count".

## A REFUSAL BELONGS TO THE FUNCTION THAT ANSWERS, NOT TO THE ONE THAT RENDERS THE ANSWER
arch-review 71 abolished exactly one state: a campaign that closes `adopted` while nothing anywhere is
authorized to register what it adopted. arch-review 72 then made a label-only adoption say so — and put the
refusal in the PROOF MINTER:

    campaignAdoption(frame, rounds)   → adopt{version}       ← the gate still says yes
    adoptionProofOf(answer, …)        → undefined            ← nothing to authorize
    settle(…)                         → state "adopted", adoption undefined

So the wave that was tightening the evidence reopened the abolished state, at the same seam, one commit
later, green in every suite — because the route fixture asserts the close and never asks what the close
authorized (arch-review 73 P0).

A minter's `undefined` is not a refusal. It is a rendering that produced nothing, and every caller that
does not ask reads it as "no rider this time" — the optional-field shape this whole file is about.

- **A declaration is enforced by the function whose answer it changes.** `allowLabelOnlyAdoption` is a
  frozen frame declaration, so it is consumed by the gate — rule `suite` already says a declaration is not
  constitutional until the deciding function consumes it, and this is that sentence applied to a refusal
  rather than to a metric.
- **Then make the bad pair unrepresentable at the write.** A gate that refuses is a gate some later change
  can stop refusing. `answer.kind === "adopt"` with no proof throws in the settle — unreachable by
  construction, which is exactly why it stands: it is the seam that state would have to re-enter through.
- ⚠️ **An unreachable guard gets NO mutation rung.** A rung whose suite cannot go red is a worse lie than
  no rung (rule `testing`); say in the comment that it is an exhaustiveness assertion, alongside
  `assertNever`, and put the rung on the gate that can.
- **The fixture population is part of the finding.** Nine gate tests, two transport tests and one store
  test failed the moment the gate tightened — all of them adopting with no sealed spec digest. They were
  not testing the waiver; they had DRIFTED onto it, because a fixture that omits an optional field takes
  the weak branch silently. A builder whose default is the weaker path makes every case that does not
  care about identity into an identity test. Default the fixture to the REAL shape and let the one case
  that is about the weak branch opt in by name.

## A COMMENT CLAIMING A STATE IS ADDRESSABLE IS A CLAIM ABOUT A TRANSPORT
The same wave's operation was described in its own counterexample as *"`decided` is the state a crash lands
in — visible, addressable, re-drivable — where a campaign that merely said `adopted` was none of those"*.
Nothing in `apps/api` ever called `forCampaign`. It was none of the three: an adopted campaign left a
durable authorization no caller could read, so none could present it either (arch-review 73).

This is the comment-is-a-claim law with the promised component being a ROUTE rather than a function. It is
easier to miss for exactly one reason: the store method exists, is exported, and is unit-tested, so every
grep for the capability succeeds.

- **A recoverability claim names the read that performs it.** "Re-drivable" means some transport can fetch
  the thing and re-present it; grep for a CALLER in `apps/*/src`, not for the method.
- **A durable operation ships with its read in the same change** — and on both transports, because
  BFF↔MCP parity is structural (rule `api-layer`). An operation an agent cannot see is one no agent loop
  can converge.
- Absent is an ANSWER here, not a 404: a halted campaign authorized nothing, and a caller must be able to
  tell that from "no such campaign".

## A FIX CAN CREATE THE NEXT DEFECT BY CLOSING THE LOUDER HALF
The same wave taught an unconfirmed artifact ref to converge: probe the store, and `absent` means the write is
not coming, so the debt may close (`abandoned`). That is right when the writer is finished and wrong while it
is merely paused:

    loser:  owe(K) → PAUSE before put
    winner: settlement → row gc_owed
    sweep:  probe K absent → abandoned → row COMPLETED
    loser:  resume → put(K) → confirm(K)      ← the object now exists, owned by nobody

Before the convergence arm this leaked RETRIES — noisy, visible, and the row stayed owed, so the late put was
eventually collected. After it, the same race leaks an OBJECT and nothing is left looking (arch-review 71 P1).

- **`absent` is a fact about the store, not about the writer.** Concluding "the write is not coming" needs the
  WRITER to be provably done: its attempt terminal, or a write lease expired. Otherwise the probe has read a
  moment, not an outcome.
- **When a change turns a loud failure into a quiet one, say which failure replaced which.** A retry storm is
  a worse day and a better signal than a silent orphan; trading them is a decision, and it was made here
  without being noticed.
- The mirror already existed and was not applied: `owe` re-opens a settled row when a stage arrives late.
  `confirm` on a settled row is the same event from the other side and does nothing.

## A CALLBACK THAT RAN IS NOT BYTES THAT LANDED
arch-review 67 moved the agent handover to the right MOMENT — the backend calls `acknowledgeResult` inside
its try, before the `finally` that reclaims the container — and arch-review 69 made the Scheduler carry it.
The ordering is now correct in production and the guarantee is still empty, because the acknowledgement's
type is `CaseResult → CaseResult`:

    await stageAgentHalf(...);   // Promise<void>, ends `.catch(() => undefined)`
    stagedEarly = true;          // proves the FUNCTION was called

So a put or a confirm that failed produces a successful acknowledgement, a reclaimed Job, a verifier running
against a digest whose bytes do not exist, and — because `stagedEarly` gates it — no fallback attempt either
(arch-review 70 P0).

⚠️ THE SAME FILE ALREADY CONTAINED THE FIX, 120 LINES DOWN. `stageVerifierVerdict` returns
`VerdictStageOutcome` and deliberately does not swallow; arch-review 67 wrote that for the verdict and left
the agent half as it was. Sibling-lane, eighth occurrence (58 · 59 · 61 · 64 · 66 · 67 · 69 · 70), shortest
distance yet — which is the strongest argument there is that proximity does not transfer a law.

- **A handover returns a PROOF, not the document it was handed.** A staged/absent union carrying the ref —
  the shape `VerdictStageOutcome` already has — not the same `CaseResult` back. A caller whose next act is
  destroying the only other copy must be able to tell those apart, and a type that cannot express the
  difference guarantees nobody will.
  ⚠️ This bullet first cited a handover type by a name nothing declared, and `pnpm docs-check` refused it.
  That is the gate working: a rule may not teach a name the repo does not have. A name that does not exist
  is written WITHOUT backticks, exactly as a deleted one is.
- **Both stages of a two-phase case answer the same contract.** If one of them returns an outcome and the
  other returns `void`, the difference is not a design choice; it is the half somebody has not done yet.
- The swallow belongs at the site that DECIDES what the loss costs, never inside the writer. Rule `protocol`
  already says a swallow inside a function named `stage`/`persist`/`commit`/`acknowledge` is reviewed as a
  protocol decision — this is that rule, unenforced, one wave later.

## A POLICY THAT EXISTS IS NOT A POLICY THE DEPLOYMENT CHOSE
`VerifierDurabilityPolicy` (`required` | `best_effort`) was added so a deployment could say what an
unwritable verdict costs. No production constructor passes it, so every deployment silently takes
`best_effort`, and `durability: "required"` appears only in tests (arch-review 70 P0).

    the policy type exists   ≠   this deployment selected a policy

This is "a constructed capability is not a delivered one" in its third form: not a missing producer, not a
producer that misses a consumer, but a DEFAULT standing in for a decision nobody made. It is more dangerous
than either, because the default is the permissive arm.

- **A policy whose arms differ in what they LOSE is selected explicitly at the composition root**, from
  configuration, and the readiness surface reports which arm is in force. A default is acceptable only when
  it is the strict one, or when the loss is disclosed where an operator will read it.
- **A trust-grade claim validates its own preconditions at startup.** "Private verifier enabled" implies an
  attempt store, an artifact store, a cleanup store and `required` durability; a deployment missing any of
  them may still run, but it may not be described as crash-safe.
- Two sentences that cannot both be true: *this verdict is constitutional evidence* and *a failed verdict
  artifact continues as an ordinary success*.

## CANONICAL TRUTH AND CLEANUP ELIGIBILITY ARE BORN TOGETHER OR NOT AT ALL
The cleanup ledger became durable in arch-review 68 and the release is still a second commit:

    settlement transaction COMMIT   →   ✗   →   releaseForGc never ran

The row stays `retained`, and `due()` returns only `gc_owed | retry_wait` — correctly, because a retained
artifact is one a recovery may still need. So the intermediates of an execution that is already terminal are
kept forever. Not a failed delete: a row that never became eligible to be deleted (arch-review 70 P1).

- **The write that makes an outcome canonical is the write that makes its intermediates collectable.** Same
  transaction, same decision — `retained → gc_owed` alongside the terminal row, the receipt and the attempt
  adoption.
- A sweeper that flips old `retained` rows is a MIGRATION and a crash repair, never the mechanism. If it is
  the mechanism, it needs the same read the settlement had (exact terminal state, no open contributing
  attempt) and it will get it wrong in the cases that matter.
- The general form, which this file has now paid for three times: **a decision and the effect it authorizes
  must be one durable act**, or the gap between them is a state nobody owns.

## EVERY ENDING RELEASES ITS OWN REFS, AND A LOSER MAY NOT REOPEN A WINNER'S DEBT
Release is wired to the normal canonical settlement and nowhere else. `RunService.cancel()` contains zero
calls to the discharge, so a cancelled private-verifier run converges its teardown and leaves its debt
`retained` forever. Scorecard losers and superseded attempts have no release path at all.

Worse, the debt is EXECUTION-scoped and `owe` reopens it unconditionally (`ON CONFLICT … state = 'retained'`),
so a speculative loser that stages late reopens the row the winner already completed — and then loses its
commit and never releases it (arch-review 70 P1).

    winner: stage → win → release → completed
    loser:  stage (late) → completed becomes retained → loses → nothing releases

- **The refs belong to the attempt and the phase that wrote them** (`{executionId, attemptId, phase}`), and
  every ending releases its own: committed · failed · cancelled · superseded · retry-abandoned ·
  merge-refused. Execution-level GC aggregates those; it is not a shared mutable row several attempts race on.
- **Enumerate the endings, not the happy path** — arch-review 66 wrote that sentence about deriving refs from
  a receipt, and it is failing again one level down because the row, not the coordinate, is now shared.
- A `state` field that answers both "does this execution still need its artifacts" and "did THIS attempt
  finish" is one value doing two jobs, which is the annotation failure this whole file is about.

## A PLANNED WRITE IS NOT A WRITTEN ARTIFACT
`owe` precedes the put deliberately, so a ref can name bytes that do not exist. The reconciler respects that
(`written !== true` → do not delete, defer) and the INLINE discharge does not — it removes every released ref
without looking. Deleting an absent key succeeds everywhere, so the settlement completes a debt whose put is
still in flight, and when that put lands the object has no owner (arch-review 70 P1).

And the half that remains even after the inline path is fixed: an unconfirmed ref is deferred forever. If the
writer died and the write genuinely failed, `written` never becomes true and the row retries until someone
looks at it.

    the put is still in flight   ≠   the put will never land

- **`planned | written | abandoned`**, converged after the canonical settlement by an EXACT object read:
  digest matches → written, then delete; absent with no live writer → abandoned; unreadable → `retry_wait`,
  because "we could not find out" is L2's third value and never a terminal.
- **One evaluator, shared by the inline discharge and the reconciler.** L5 already says one verifier serves
  the request path and the sweep; two readings of one ref is that law broken for artifacts.
- A vocabulary without a transition owner is not a lifecycle. `written?: boolean` existed; nothing was
  responsible for making it true or giving up on it.

## A CONSTRUCTED CAPABILITY IS NOT A DELIVERED ONE
`unwired-capabilities` was built in arch-review 67 for the law above, and it asks one question: does some
composition root CONSTRUCT an implementation of this port? Two waves later the cleanup ledger was constructed
in `persistence.ts`, handed to the agent half's lane, and never handed to the verifier's — so the check passed
while `verifier-verdict/…` objects were written with no ledger row naming them, one per completed case,
forever (arch-review 69 P1).

    a producer exists   ≠   the producer reaches this consumer

- **A capability with two consumers is wired in two places, and the second one is the one nobody does.** When
  a port gains a consumer, `grep -n` for every OTHER site that declares the same dep optional and count them
  in the commit message — the same instruction the one-lane-only law gives, applied to composition rather
  than to a guarded write. This series has now found that shape SEVEN times (58, 59, 61, 64, 66, 67, 69), and
  this is the first where the two lanes were the two halves of the feature being wired.
- **The scanner and the test are different shapes on purpose.** A test cannot prove a producer exists — a
  test that constructs one has just supplied the thing whose absence is the bug — so the scanner owns that.
  A scanner cannot cheaply prove delivery through a composition root, so a counterexample that DRIVES the
  root owns that. Neither substitutes for the other, and a feature with an optional dep needs both.
- The tell at the call site is the same `?.` as ever, which is why neither reading nor typechecking finds it.

## A SUB-STEP'S TERMINAL IS NOT THE CANONICAL TERMINAL
`committed` means "this attempt's result is the case's answer". The verifier lane stamped it the moment its
container returned scores — before the merge decides whether the verdict is USED, before the deferred trace
is collected, before the settlement writes anything. So the row said a verdict had been adopted while three
later steps could still discard it, and the compensating `committed → superseded` could never run: the store
is first-terminal-wins and `committed` is terminal (arch-review 64).

Two states, two words. A phase that means "this sub-step produced bytes" is NOT terminal, because work that
follows it can still refuse those bytes; only the write that makes the outcome the record's answer may write
the terminal that claims it.

- The canonical terminal is written **by the settlement transaction and by nothing else**. A lane that
  produces evidence stamps a pre-terminal phase (`verdict_produced`) and stops there.
- **A compensation that a state machine's own rules forbid is not a compensation.** Before writing "and if it
  turns out wrong we correct it to X", check that the transition X is reachable from where the row will be.
- Adding the phase is a vocabulary change: re-walk `TERMINAL_ATTEMPT_STATES`, `EXECUTING_PREDECESSOR_STATES`,
  `MAY_STILL_CREATE_WORK`, both stores' transition tables, the cancellation's revocable filter and every
  reader — see the phase-readers law above, which is the same law from the writer's side.

## A HOST-KEYED RENDERING COLLAPSES REPOSITORY-SCOPED GRANTS
Two mint calls produced two credentials for one registry — one covering the task image's repository, one the
runner image's — and both were appended to a single `RegistryAuth[]`. Then:

    dockerAuthConfigJson   auths[entry.host] = …      → the LAST entry for a host wins
    pickRegistryAuth       auths.find(…)              → the FIRST entry for a host wins

Two consumers of one list resolving it in opposite directions, and the rendered docker config carries exactly
one token per host, so the other image gets a 401 that reads as a registry problem. `registryAuthsForImages`'s
own comment claimed "Deduplicated by host: one entry per registry" and its body is a plain filter
(arch-review 64).

- **A list keyed downstream by a coarser identity than it was minted for is not a list, it is a race.** When
  the consumer's shape is `Record<host, credential>`, the producer owes ONE credential per host covering every
  repository that host serves — collect the refs first, mint once.
- Enumerate by the **physical consumer**: what this pod will pull, not what this layer happens to know about.
  The runner/init image is pulled by the same kubelet as the task image, and a lane that never sees the
  runtime spec (the verifier's) is a lane whose pod pulls images nobody minted a grant for.
- A comment describing a merge, over a body performing a filter, is the comment-is-a-claim law in miniature.

## A DOUBLE THAT ALWAYS SUCCEEDS IS NOT A STORE
The recovery test above passed because its ledger double was

    transition: async (id, to) => { closed.push([id, to]); return true; }

`transition` is a CONDITIONAL write whose whole purpose is to answer `false`, and this double cannot. So a
guard that refuses every real call read as a green test, and the assertion "the attempt was closed" recorded
that we had ASKED, not that anything had happened.

This is the fake-more-permissive rule (rule `testing`) at its sharpest, because the permissiveness is in the
return value rather than in a missing branch:

- **A double for a guarded write returns what the real one would.** If the production store can say `false`,
  the double decides `false` from the same inputs — or the test uses the real in-memory implementation,
  which exists precisely so this is cheap.
- **This one is MACHINE-CHECKED now** (`pnpm guarded-doubles`, CI-required), because the prose version did
  not hold: the wave that wrote this law shipped `transition: async (id, to) => { moved.push(…); return true }`
  as its own counterexample, on the same day, for a correction production could not even reach. A rule its
  author broke while writing it is a note. The scanner flags a hand-written double for a conditional write
  whose only outcome is the success value; an allowlist entry says whether granting is the test's PREMISE
  (fine) or an `OPEN` defect with an owner (not fine, and removed by that owner's change).
- **Assert the OUTCOME, not the call.** `closed` recording a call proves an attempt was made; the row's state
  proves the write landed. Where an in-memory store exists, read it back.
- A `Promise<boolean>` double that never returns `false`, or a `Promise<void>` double over a method that
  throws, is a green light wired to nothing.

## ⚠️ THE LAWS BELOW WERE BROKEN BY THEIR OWN AUTHOR, ONE WAVE LATER — HERE IS WHY
Three findings of arch-review 67 are laws already written here, violated by the change that closed the
review before it:

    "an optional dependency with no producer is a plan"   (64)  → the cleanup store, wired in tests, has
                                                                   no production constructor at all
    "a conditional write in a transaction is not success" (66)  → fixed in the recovery lane, left in the
                                                                   ordinary settlement two files away
    "unknown is unignorable"                        (L2, long)  → the new acknowledgement swallows its own
                                                                   store write and reports success

A law nobody disagrees with, broken immediately by the person who wrote it, is not a knowledge problem. It
is that **each of these is invisible at the site where it is committed**:

- **The optional dep looks wired because the TEST wires it.** Writing `cleanup?: Store` and a counterexample
  that passes one makes the capability feel present; nothing at the call site distinguishes "this deployment
  chose not to" from "no code anywhere constructs this". So: when a capability is introduced, its production
  CONSTRUCTOR is written in the same change, or the change is not finished. Grep the composition root for
  `new <Store>` before believing the feature exists.
- **Fixing one lane feels like fixing the protocol**, because the counterexample you just wrote is green. The
  review series has now found the one-lane-only shape SIX times (58, 59, 61, 64, 66, 67). So: after changing
  a guarded write's contract, `grep -n` for every OTHER caller of that method by name and count them in the
  commit message. Two callers is the default, not the exception.
- **A `.catch(() => undefined)` inside a function whose PURPOSE is durability reads as the same
  best-effort idiom it is everywhere else.** It is not: here the caller's next act is destroying the only
  other copy. So: a swallow inside a function whose name contains `stage`, `persist`, `commit` or
  `acknowledge` is reviewed as a protocol decision, never as hygiene.

The general form, and the reason this block sits at the top of the file: **a law is applied at the moment of
writing a call site, not at the moment of reading a rule.** What makes it applicable is a mechanical check —
a scanner, a required parameter, a compiler flag — and where the check does not exist yet, the law is a
reminder that has already failed once.

## RETENTION AND DELETION ARE TWO STATES, NOT ONE
The cleanup ledger records a debt when the bytes are staged, which is right — and it records it as `owed`,
which is the state that means "delete this". From the moment the agent half exists until the case settles,
the row therefore says *delete me* about an artifact the case is still going to need. Nothing deleted it
only because no reconciler was wired; wiring one is what the row exists for (arch-review 67).

    the artifact must be RETAINED    (a crash here must be able to recover it)
    the artifact may be DELETED      (the settlement took its answer)

are opposite instructions, and one field held both. Worse, the debt is written BEFORE the object — so a
sweep between the two would delete an absent key, mark the debt paid, and orphan the write that follows.

- **A lifecycle row starts in the state that forbids the effect** (`retained`), and only the canonical
  settlement moves it to the one that permits it (`gc_owed`). A reconciler's worklist is the permitting
  states, never "everything not yet completed".
- **The debt is recorded before the bytes and CONFIRMED after them.** A row that claims an object exists
  before the put returned is a worklist entry pointing at nothing.
- The same shape as L5's escalation field: a state that means "we are not done" must not be the same value
  as one that means "act now".

## A RECEIPT EXISTS IS NOT MY RESULT IS THE ONE THAT COMMITTED
The ambiguous-commit repair (arch-review 66) read back the receipt ledger, found a receipt naming this
child, and seeded the PROCESS-LOCAL result it had been about to commit. It never compared them. So a
concurrent writer that committed a different result for that child first left the resumed batch carrying a
document the ledger does not hold, with the receipt's digest disagreeing with what the aggregate reports
(arch-review 67 P0-canonicality).

That is a worse failure than the duplicate dispatch it replaced. A double-spend is visible in cost and in
the ledger; this is silent, and the batch's own numbers are the thing that is wrong.

    something committed for this child   ≠   what I was about to commit is what committed

- **A read-back returns the PERSISTED value, and the caller uses that value** — never the local one it
  happened to be holding. The local copy is for COMPARISON, and a disagreement is a third answer
  (`inconsistent`), not a tie broken in favour of whoever is asking.
- Verify the pair, not the existence: the receipt AND the child row it names, joined on the digest the
  receipt sealed. A receipt whose child result cannot be read, or whose digest does not match it, leaves the
  operation owed.
- This is L2 and L3 meeting: the third value is `inconsistent`, and the identity comes from the row that
  won rather than from the caller that is asking.

## A CONDITIONAL WRITE INSIDE A TRANSACTION IS NOT A SUCCESSFUL ONE
The previous wave put both contributing attempts inside the settlement transaction — the right structure, and
the reason it looked finished. What it does is:

    await boundAttempts.transition(contributing.agent, "committed", { childRunId: c.id });
    //     ↑ Promise<boolean>, and the boolean is the whole answer

`transition` is a guarded UPDATE. In real Postgres its `committed` arm carries `PARENT_AUTHORIZES`, which
requires `parent.owner_epoch = a.driver_epoch` — and a boot recovery RAISES the parent's epoch when it claims
the batch (`claimOwnership`, the fencing token). So every attempt the recovery adopts was opened under the
epoch before the claim, every `committed` is refused, and the transaction commits the canonical outcome on top
of two no-ops: receipt committed, child succeeded, both attempt rows still reading as live compute that was
reclaimed (arch-review 66 P0).

    the call is inside the transaction   ≠   the write happened

- **A decision that rests on a conditional write consumes its answer.** Membership in the transaction buys
  atomicity for the writes that LAND; it says nothing about whether this one did. This is L1's
  "never `Promise<void>`" one layer in: returning the boolean is not enough if the caller discards it.
- **`false` IS NOT ONE ANSWER.** already-adopted, revoked, failed, superseded, wrong epoch, parent no longer
  open and absent all collapse into it, so a settlement cannot tell "somebody else already did this" (fine)
  from "this attempt may not be adopted at all" (abort). Where a caller must distinguish them, the store owes
  a UNION, not a boolean — and the arms are named after what the caller does with them.
- **A recovery's authority is a different question from the original driver's.** `driverEpoch` records WHO
  STARTED this compute and is provenance; it must not double as "who may adopt it now". Adoption carries the
  ADOPTING epoch and the guard checks the parent is open under it, so a fence that legitimately moved does not
  read as an attempt that may not be settled. Re-using one number for both is how a correct fence became a
  silent refusal.
- The counterexample has to run against the REAL adapter. The in-memory twin has no parent-authority join, so
  every test of this path passed while the production store refused every call (rule `testing`).

## AN ARTIFACT WITHOUT AN OPERATION IS BYTES NOBODY WILL LOOK FOR
Two waves added durable bytes — the agent half, then the verdict — and both are found by a POINTER that is
written somewhere else and later: the recovery locates the half by the digest a verifier work ref carries, and
the verdict by the verifier's attempt id. Neither is a scan. So the window between "the bytes are durable" and
"a durable row points at them" is a window in which the artifact exists and no recovery can reach it
(arch-review 66 P0-lifecycle).

    durable bytes  +  no durable pointer  =  operationally undiscoverable

Worse in the other direction: the external object is reclaimed by the lane the moment it parses the result, and
the staging happens after that call RETURNS. So every one of these is a crash that loses work already paid for:

    agent result parsed → agent Job deleted → dispatch returns → ✗ → nothing staged, nothing to recover
    half staged        → ✗ → no verifier handle exists, so no pointer names the half
    verifier logs read → verifier Job deleted → ✗ → the verdict is gone

- **The durable acknowledgement precedes the external cleanup, not the other way round.** A backend that
  deletes its object and then hands the caller a value has made the caller's next line load-bearing for
  correctness. Order: read the result → canonicalize → write the immutable artifact → CAS the operation →
  acknowledge → THEN reclaim.
- **A multi-step effect gets one aggregate that owns it**, whose state says which step is next and which
  artifacts it owes — not N artifacts plus N rows plus a settlement, none of which is responsible for the
  whole. This is L5's "a debt owns its worklist" for the forward path.
- Where a deployment legitimately has no artifact store, say what it loses (the recovery) — but a deployment
  running private verifiers must not have that store as an OPTIONAL dependency, because the thing it is
  optional for is the only reason the case can be finished at all.

## A MEASUREMENT DOCUMENT IS NOT A PLACE TO PUT PLATFORM CONTROL STATE
The GC coordinate was added to `CaseResult` — the document a grader produces, a runner submits, a receipt
digests, and a leaderboard compares. Three consequences, and only the first was intended (arch-review 66):

- **Identity.** The normal path attaches it and the recovery path does not, so the same agent bytes and the
  same verdict produce different `caseResultDigest` AND `caseObservationDigest` depending on whether a process
  crashed. An observation digest exists precisely to say "the same thing was observed"; lifecycle metadata in
  it makes one measurement read as two experiments.
- **Authority.** `submit_job_result` parses the runner's JSON with the same schema, so a workspace-controlled
  runner can name the objects the settlement will delete. Not cross-tenant — the keys use the settlement's own
  tenant and execution — but a sibling attempt's staged half is inside that boundary, and a result is not a
  cleanup instruction.
- **Review.** The field reads as evidence because everything around it is.

So: **the untrusted execution surface, the canonical measurement, and the platform's private lifecycle state
are three schemas.** A field that answers "what should the platform do next" is never on the one that answers
"what did the agent do". Strip platform-only fields AT the execution boundary rather than trusting producers
not to send them, and keep them out of anything a digest covers.

## A CONTENT-DERIVED ADDRESS IS NOT CONTENT AUTHENTICATION
`agentHalfKey` carries the result digest, which was the right fix for a key two attempts shared. It is not
integrity: nothing re-digests the bytes that come back, the S3 adapter writes with a plain `PutObject` (no
conditional create, no stored digest, same key overwrites), and a different schema-valid `CaseResult` at that
key is merged as though it were the one the digest names (arch-review 66 P1-provenance).

    the digest is IN the key   ≠   the bytes hash to it

- **Verify at the read.** An artifact whose address encodes its content is checked by re-deriving that content
  on the way in; otherwise the address is a naming convention with a strong-sounding shape.
- **An immutable artifact is written immutably** — conditional create, or a versioned key — or the word
  "immutable" is doing work the storage layer never agreed to.
- **Absent is not "matches".** A guard written as *"present AND different → refuse"* accepts a document that
  omits the field entirely, which is the easiest thing for a wrong or forged artifact to do. The durable form
  of a coordinate is REQUIRED; optional-and-compared is the shape that admits silence.
- And say out loud what an incomplete artifact may still do. `complete: false` on a receipt is a label; if the
  scores ride into the case anyway, the label is advisory exactly where the constitution is decided — the
  annotation failure this whole rule file is about. Decide it, fail-closed, and test the refusal.

## AN INLINE CLEANUP AFTER A COMMIT IS NOT A LIFECYCLE
The discard runs after the settlement returns, in the same process, best-effort. That covers the ending where
nothing went wrong, which is the ending that needed no help. Every other one leaks: a transient refusal
rethrown for retry orphans the first attempt's stage (the re-run's digest differs), a refused post-stage CAS
orphans the verdict because the caller never receives the invocation that names it, one of the two recovery
owners never discards at all, a crash between the commit and the delete is retried by nobody, and a delete
that fails is swallowed (arch-review 66 P1-high).

- **The debt is recorded in the transaction that creates it** — the same write that makes the outcome
  canonical — and a reconciler drains it. Inline deletion is then a latency optimization whose failure costs
  nothing, which is the only shape in which "best-effort" is honest.
- **Enumerate the endings, not the happy path.** committed · failed · unmeasured · superseded · abandoned
  retry · adopted-by-recovery. If any of them cannot name what it staged, the ref is in the wrong place
  (see the every-ending law below, which this one is the durable half of).

## THE DOCUMENT THAT BECOMES DURABLE IS THE DOCUMENT THAT IS RETURNED
A verdict was persisted so a crash could recover it, and what got persisted was the LANE's raw answer while
the value returned to the caller was `{...invocation, work: persistedWork, agentAttemptId}` — the attempt id,
the protocol coordinate and the judged execution, joined from the reservation after the lane replies. The K8s
lane reports `{tenant, runId, externalJobId, namespace}` and nothing more, and `VerifierReceipt.complete`
requires exactly the three that are joined. So one verifier execution read `complete` in-line and
`incomplete` after a crash: a difference in the RECORD produced by whether the process survived
(arch-review 65 P0).

    persist(upstreamValue)  …  return enrich(upstreamValue)     ← two documents, one of them recoverable

- **Assemble the canonical value first, persist THAT, then stamp the state.** Each step is a precondition of
  the next, and the order is the protocol: a recovery must not be able to observe a document the normal path
  would never return.
- **Persist AFTER every check that can still reject.** The stage ran above the two guards that refuse a lane
  naming a different container than it reserved, so a verdict this process refused was left on the stage for a
  restart to adopt. A rejected value that is already durable is a rejection only this process honours.
- The recovery's half of the same law: **staged bytes are ADDRESSED, not authenticated.** Live adoption
  re-presents the coordinates it holds; a staged path that merges whatever it read is a second protocol for
  one question, and only one of the two verified. Check what you read against the handle you are recovering
  from — attempt, external id, and every digest the handle carries — and answer `unknown` on disagreement,
  never `absent`: something IS there and we could not use it.
- **A key built from what two producers SHARE is a key at which the later write wins.** `put` is not a
  conditional create. Keying a verdict by `(tenant, runId, agentResultDigest)` — all three properties of the
  half being judged — let two verifier attempts overwrite each other, and a recovery holding the loser's
  handle read the winner's bytes. The producing attempt is the discriminator, and every recovery already
  holds it.

## TWO CONTRIBUTORS CANNOT BE ONE COORDINATE
A case with a private verifier is TWO physical executions, and both recovery owners carried a single
`RuntimeWorkRef` to the settlement — the JUDGING container's, because that is the handle the merge was
reached through. So `resume(…, attemptId)` and `receipt.attemptId` named the verifier while the agent's row
stayed open. `attemptId` on a receipt is what a trajectory read resolves an evidence plane against, so a
recovered case could serve the verifier's output as the case's evidence (arch-review 65 P0-verifier).

- When an outcome has more than one producer, the type says so (`ContributingAttempts {agent, verifier}`) and
  each consumer names which one it means. A single field cannot be spent for one and read as the other.
- **Every ending owns its cleanup debt.** The GC coordinate was read out of the receipt, which exists only on
  a case that settled with a COMPLETE one — so a producer that errored, a merge that was refused and a
  capacity-refusal retry could not clean up after themselves. The refs are stamped by the pass that WROTE the
  intermediates, on every outcome including the failures; deriving them from the document that happens to
  succeed only ever covers the path that did not need it.
- ⚠️ The comment defending the single coordinate was written in this repo and it was wrong: "the agent's was
  committed before its half was staged". In that lane the agent's attempt is stamped BY the settlement, which
  runs after the whole pass. The comment-is-a-claim law applies to your own comments about your own lane.

## AN INTERMEDIATE ARTIFACT'S WINDOW ENDS AT THE SETTLEMENT, NOT AT THE STEP THAT USED IT
The staged agent half was given a retention owner, and the owner was placed at the merge — the step that
consumes the half. That is one step too early. After the merge the case still collects its deferred trace,
runs its observation graders, assembles its evidence and commits; a crash anywhere in there now finds the
verifier's container gone, the agent's container gone AND the staged half deleted, so the case re-runs from
nothing (arch-review 63 P0).

The rule the first version got wrong: **an artifact that exists so a crash can be recovered from is owed
until the thing it would recover is durable.** Not until its value has been read — a value in memory is
exactly what it was staged to survive.

- The window closes at the CANONICAL settlement (the write that makes the outcome the record's answer), and
  the GC is that settlement's, not the consuming step's.
- A separate sweep for abandoned intermediates is a safety net for operations that died, never the primary
  owner — the same relationship the reconciler has to a request-path teardown (L5).
- A counterexample that asserts the earlier deletion is asserting the defect. Rewrite the invariant; do not
  keep the test green by keeping the behaviour.

## Definition of done for a protocol change
1. The counterexample exists and was seen RED **for the stated reason** (see rule `testing`).
2. `pnpm protocol-mutations` neutralizes the new protocol in the production file and the owning suite goes RED.
   A mutation whose target line no longer exists FAILS — a deleted subject never silently stops being tested.
3. The escape hatch is deleted in the same change: the optional hook, the `void` writer, the boolean+optional
   pair, the allowlist entry. A migration that leaves both shapes alive asks every future caller to pick, and
   the call site never shows which one is safe.
