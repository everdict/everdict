# Case law — how each law was paid for

Every entry is a real defect that shipped, passed review, and was found by a later one. They are recorded
with the *reasoning that was written down at the time*, because that reasoning is persuasive — it is what the
next session will think too. The line numbers are as of `66afa78a` (2026-08-17) and drift; the shapes do not.

Read the entry that matches your temptation, not the whole file.

---

## L1 — Authority before effect

### 1.1 The pre-effect hook that no-ops
`packages/application-control/src/scorecard/case-outcome-committer.ts:600`,
`packages/application-control/src/run/run-service.ts:1288`

```ts
async stampWork(work: RuntimeWorkRef): Promise<void> {
  const attempts = this.deps.attempts;
  if (!attempts || work.attemptId === undefined) return;   // ← resolves; nothing persisted
  await attempts.recordWork(work.attemptId, work);
}
```
Called from `onReserved`, which the backend awaits before creating the cluster object. With no attempt id the
hook **succeeds**, so the backend submits and the external job exists with nothing naming it. The wrong
reasoning, written above it: *"an attempt that opened no ledger row has no handle to stamp either"* — true,
and it is exactly the case that must refuse the dispatch rather than proceed silently.

**Shape:** the store returns a proof (`PersistedWorkIntent`) and `submit(job, intent)` requires it. There is
then no state in which the effect runs without the proof, and no hook to forget.

### 1.2 The ledger fault that degrades into no identity
`packages/application-control/src/execution/open-physical-attempt.ts:68`
```ts
const opened = await attempts.open(input).catch(() => undefined);
if (!opened) return { unisolated: true };                   // ← no attemptId, dispatch continues
```
The comment above it is CORRECT and still insufficient: a ledger outage must not fall back to the recording
store's self-mint (that re-activates a two-authority generation split). The error was concluding that
*therefore* the execution proceeds unnamed. Two different lanes were being decided at once.

**Shape:** split the lanes. A refused *recording claim* → `unisolated`, keep running (the fence is lost, the
row exists). A failed *ledger open* on a **managed** lane → refuse the dispatch. Diagnostic/in-process lanes
may still degrade.

### 1.3 The writer that cannot fail
`packages/db/src/results/pg-execution-attempt-store.ts:165` — `UPDATE … WHERE attempt_id = $1` with no
`RETURNING` and no affected-row check; the in-memory twin returns silently when the row is absent. Updating a
row that does not exist reads as success at every call site.

**Shape:** `Promise<void>` is banned for a write a decision rests on. Return the row (`… RETURNING`) or the
count, and throw on zero.

### 1.4 Lifecycle before durability
`packages/backends/src/orchestrators/k8s.ts:1559` fires `onStarted()` (run → `running`) *before*
`onReserved` (:1575) and `applyJob` (:1587). A reservation failure then leaves a run marked running with no
cluster object anywhere. Order is contract: `queued → reserving → submitted → running`, and `running` means
the cluster started something.

### 1.5 Both shapes alive (arch-review 53 Wave B → legacy removal)
Wave B added exact `killWork`/`adoptWork` and kept the case-id `kill`/`adopt` "as a fallback for pre-handle
rows, forbidden on decision paths by a scan". That asked every future caller to know which of two functions
was safe, and the call site never showed it. The deletion — not the scan — is what closed it.

**Rule:** a migration that leaves both shapes alive has not migrated. Delete the escape hatch in the same
change.

---

## L2 — Unknown is unignorable

### 2.1 The companion boolean nobody read
`apps/api/src/composition/runtime-access.ts:99-113` returns `{ result?: CaseResult; established: boolean }`;
`established` is set to `false` on `unknown` with a comment saying *"the caller must not re-dispatch on it
(double-spend)"*. The caller at `:437-444` reads only `outcome.result`. The flag was never consumed — for a
full review cycle, while its own comment explained why it mattered.

**Shape:** `AdoptionDecision = {kind:"adopted",result} | {kind:"absent"} | {kind:"unknown",reason}` with an
exhaustive switch. A union cannot be half-read.

### 2.2 The swallow the scanner allowed
`apps/api/src/composition/runtime-access.ts:433` — `workHandlesFor(...).catch(() => [])`, i.e. an unreadable
attempt ledger becomes "this run placed no compute", which sends recovery to re-dispatch.

Worse, the `unknown-collapse-guard` scanner written to stop exactly this **allowlisted it**, with:
> *"ADOPTION's lane scan. An unresolvable lane there falls back to RE-DISPATCH, which spends compute but
> cannot produce a wrong verdict"*

That is false twice: a second physical attempt writes competing evidence, and a harness with external side
effects fires them again. The line was also invisible to the scanner anyway — `WATCHED_READS` matches
`attempts.list`, not `workHandlesFor`.

**Rule:** an allowlist entry is a place the type failed to say it. "It only costs compute" is not a reason.

### 2.3 The adapter that turns 5xx into "nothing there"
`packages/backends/src/orchestrators/nomad.ts:1238` — `findJob` returns `undefined` when
`res.status >= 300`; `adoptWork` (:1017) maps `undefined` → `{status:"absent"}`. The comment two lines above
says *"A read that FAILED is `unknown`"*. **The comment and the code disagree.** K8s (:1111) gets it right:
`jobsByLabel` → `undefined` → `unknown`, and only a successful listing that omits the name is `absent`.

The conformance suite did not catch the asymmetry because it asserted the *method exists*, not what it answers
when the cluster errors.

---

## L3 — Provenance is born at the source

### 3.1 Identity re-derived from a metric string
`packages/domain/src/scorecard/scoring-revision.ts:357`
```ts
const judgeId = score.metric.startsWith("judge:") ? score.metric.slice("judge:".length) : undefined;
```
A namespaced judge writes `judge:<id>:<criterion>` (`packages/graders/src/judge.ts:212`), so judge `a` becomes
three phantom judges — `a`, `a:helpfulness`, `a:safety` — each minting a receipt whose `evidenceEmitter` names
a plane that does not exist. Receipts exist to join to evidence; the join key was wrong.

**The correct predicate already existed** in the same repo, `packages/application-control/src/trace-sink/trace-sink-service.ts:43-49`:
```ts
function judgeIdOf(metric: string): string | undefined { /* first segment after "judge:" */ }
```
**Rule:** a predicate written twice has already diverged. Grep for the concept before writing the helper; a
receipt is minted by the invocation, not reconstructed from its output.

### 3.2 Presence mistaken for coverage
`scoring-revision.ts:242-258` — `input.judgments !== undefined` decides `kind:"recorded"`. `[]` is not
`undefined`, so an EMPTY receipt vector is recorded provenance, and `packages/domain/src/scorecard/gate.ts:96`
only asks `kind !== "recorded"`. A batch with selected judges and 100 judged cases can carry zero receipts and
pass the gate as vouched.

**Shape:** provenance states `expectedUnits`, `recordedUnits`, `complete`; the gate requires equality.

---

## L4 — A settlement owns immutable bytes

### 4.1 The payload re-read at drain time
`packages/application-control/src/scorecard/publication.ts:250-255` refuses permanently when
`contentDigest(results) !== effect.payloadDigest`, and the coordinator re-hydrates the record's *current*
results (`:296-298`, *"Re-read rather than remembered, because the process that planned this is gone"*).
A perfectly legitimate re-score therefore makes the earlier settlement's owed export **permanently
unverifiable** — the operation survives, the bytes it must ship do not.

Note the asymmetry: the *artifact* effect in the same function already does it right (`:229-240` reads an
immutable staged object and verifies its digest). Only the export half re-reads live state.

### 4.2 The alias with no revision guard
`publication.ts:240` — `artifacts.put(effect.key, …)` unguarded. Two independent operations completing out of
order move `analyses/<id>.json` backwards. `current` is a monotonic projection, not an ordinary effect.

### 4.3 The idempotency key that arrives unreadable
`publication.ts:266` passes `idempotencyKey` under the comment *"THE KEY TRAVELS TO THE SINK"*. It travels
further than the comment can prove and stops short of mattering. `apps/api/src/composition/scorecard.ts:368`
forwards the ctx object to `TraceSinkService.exportScorecard`, whose `ExportContext`
(`trace-sink-service.ts:33-39`) does not declare the field, and `TraceSinkContext` in `@everdict/contracts`
never had it either.

The property is **not** dropped — excess-property checking applies to object literals, not to a variable
passed into a narrower parameter type, so at runtime `sinkImpl.export(ctx, …)` receives an object that still
carries the key. It is simply invisible to every adapter, none of which declares or reads it; they mint fresh
UUIDs per call. The distinction matters when fixing it: nothing needs to be re-plumbed, the CONTRACT needs to
admit the field.

**Rule:** an at-least-once effect's idempotency key belongs in the PUBLIC contract, typed to the adapter,
which derives deterministic external ids from it. "Unconsumed" and "dropped" look identical from outside — and
the sending side's comment claims neither happened.

---

## L5 — Completion is verified zero

### 5.1 Two protocols for one teardown
`packages/application-control/src/cancellation/cancellation-coordinator.ts:127` — the reconciler calls
`teardown()` directly and on failure calls `cancellations.fail(target, msg, now())` **without the `state`
argument**, so it never records `verifying`, never increments `verificationAttempts`, never abandons. The
caller-facing `runDurableTeardown` in the same file does all three. The process that is alive and the process
that restarted converge differently.

**Shape:** one `advanceCancellationOperation(operation, teardown, verifier)` used by the request path, the run
reconciler and the scorecard reconciler.

### 5.2 The read-back that only one lane does
`activeManagedWork` is probed only in `run-service.ts:1593-1605` (standalone runs). The scorecard teardown
certificate records child rows and kill responses; its own comment admits no field claims the orchestrator job
was re-probed. Terminal children are not an exited container.

### 5.3 Escalation shaped as terminal
`packages/db/src/results/pg-cancellation-store.ts:122` — `listIncomplete` excludes `unverifiable` alongside
`completed`. Closing a row we could not verify removes it from the only loop that would ever retry it. The
debt is real; only the *retry frequency* should change, plus an operator signal.

---

---

## Review 55 — the defects a fix can CREATE, and the ones a proof cannot prevent

### R55.1 A refusal added for safety, consumed as a verdict ⚠️ SELF-INFLICTED
`packages/application-control/src/scorecard/recovery-planner.ts` (arch-review 54, Phase 2)

Phase 2 made the batch planner REFUSE to plan when the attempt ledger could not be read — correct, because a
case that is not seeded gets re-dispatched, and re-dispatching over live compute double-spends. It refused by
throwing, with this comment:

> *"The caller already treats a throw here as 'not faithfully resumable' and leaves the batch for the next
> sweep, which is the honest outcome."*

The caller did no such thing. `ScorecardBatchService.resume` caught everything into `false`, and the boot sweep
read `false` as **tombstone**: `settleScorecard(..., { status: "failed", error: INTERRUPTED })`. So a guard
added to prevent a double-spend recorded the batch as an evaluation that FAILED — permanently, in history —
while its managed jobs were still running. Strictly worse than the collapse it replaced.

Two rules came out of it, both now in `protocol.md` L2:
- **A throw is not a third value.** It is caught by the nearest generic handler and becomes THAT handler's
  meaning. Return the union.
- **The union is not done until the consumer chain is.** Introducing `unknown` at the producer moves the
  question; someone must still name the case at the point a DURABLE decision is written. Walk it.

And the meta-lesson, which is why this entry leads: **a fix verified only at its own layer can be worse than
the defect.** The counterexample proved the planner refused. Nothing asked what the refusal became three
frames up.

### R55.2 An answer given before the work that would justify it
`apps/api/src/composition/runtime-access.ts` — `resumeRun` started `void (async () => { … })()` and then
`return true`. The sweep counted the run as resumed; the background leg, on `unknown`, simply returned. The
row stayed claimed by this replica, `running`, driven by nobody — and the next booting replica reads exactly
that as "another live replica has it".

**Rule:** a fire-and-forget leg may not report an outcome its caller has not reached. Either await it, or
report what it actually is (`retry_later`) and let the sweep come back.

### R55.3 A proof that outlives its authority
`packages/db/src/results/pg-execution-attempt-store.ts` — `reserveWork` is
`UPDATE … WHERE attempt_id = $1 RETURNING …`. It refuses an attempt that does not exist (Phase 1's fix) and
accepts one that is **cancelled, superseded, terminal, or belongs to a batch a newer epoch now owns**. So a
driver displaced by a takeover can no longer commit an outcome and can still authorize new external compute;
two dispatches onto one attempt both succeed, and `runtime_work` is last-write-wins over the column that names
live work.

**Shape:** the authorizing write is a CONDITIONAL transition, not a metadata update — state, owner epoch,
parent liveness and "nothing reserved yet" asserted in the one statement that flips `created → reserved`.
See `protocol.md` L1's second half: a proof has a lifetime.

### R55.4 A debt stored in the subject's status
`packages/application-control/src/scorecard/scorecard-service.ts` `stopInFlight` — the teardown iterates
children that are `running`/`queued`, kills each one's exact work, and settles the row terminal **whether or
not the kill converged**. The first attempt collects the failure and keeps the operation owed. The retry
iterates the same way, skips every child it terminalized (`if (c.status !== "running" && … ) continue`), finds
nothing live, and CERTIFIES completion — over compute it never confirmed was gone.

The function's own closing comment already admitted the gap: *"no field claims the orchestrator was re-probed
for the killed jobs afterwards."*

**Shape:** the operation owns an explicit workset built from the ledger of what was PLACED. Row lifecycle and
work lifecycle are different clocks (`protocol.md` L5).

### R55.5 Provenance reconstructed at a different coordinate than it was sealed at
The Temporal driver passes judges `{ passId: initial:<sc>, claim: { generation, attempt: 1 } }`, so evidence
seals as `judge:<id>#initial:<sc>.<gen>.1`. Its finalizer then rebuilds receipts with
`judgmentReceiptsFromPlane(results, initialScoringPassId(id))` — **no `claimFor`** — so the receipt names
`judge:<id>#initial:<sc>`, a plane that does not exist. Recovery's re-judge passes no scope at all and seals
`judge:<id>` bare, against the same reconstructed name.

Phase 3's coverage check cannot see it: it counts (case, judge) units and never asks whether an emitter
RESOLVES. A receipt exists to be joined; a count is not a join.

**CLOSED (Wave 4).** The finalizer's own comment stated the reasoning that made this a protocol defect rather
than an oversight — *"the per-case claims are not reachable from here (the activity that judged has returned)"*
— and they were one map lookup away: it already holds `receiptByKey`, and a commit receipt names the physical
attempt it vouches for (`attemptId`) precisely so a later reader can answer this. The derivation moved to a
single owner beside the emitter that consumes it (`judgeClaimOfAttempt`, `@everdict/domain`), called by BOTH
the judging site and the finalize, and `claimFor` became a REQUIRED parameter — the two lanes that genuinely
have no ordinal now answer `() => undefined` instead of omitting it.

Two lessons, both generalizable:
- **A comment explaining why a coordinate is unavailable is a claim to verify, not a constraint to design
  around.** This one was written by the same change that introduced the receipts, and it was wrong about its
  own function's locals.
- **An optional parameter carrying identity is a parameter that gets forgotten** — the same shape
  `inputObservation` was made mandatory for one review earlier, for the same reason, in the same builder.
  When a value must cross a lane boundary, make the compiler ask.

### R55.6 A monotonic projection whose position could not be read, certified as published
`packages/application-control/src/scorecard/publication.ts` (arch-review 54, Phase 4)

Phase 4 made the mutable `analyses/<id>.json` alias monotonic and took the position from the operations
LEDGER rather than from the object — the right design. `aliasIsAhead` returned a BOOLEAN, with the unreadable
case folded into `true`, under a comment asserting the operation "stays owed so a later sweep can decide with
a readable ledger".

It did not. The consumer was a bare `continue` with no `fail(...)` beside it, so the effect loop fell out with
nothing owed, the drain returned `published`, and the row was `complete`d and left the sweep. A ledger blip
therefore retired the only debt that would ever have promoted that settlement's alias.

The generalizable part is NOT "another boolean": it is that **the fail-closed half was implemented and the
owed half was only written down**. Refusing to move the projection on a guess was correct and was the entire
fix; nobody checked what the refusal became one frame up — the same shape as R55.1, in a different file, in
the same review. When a guard's justification contains the words "stays owed", that clause is a claim about
another function, and it is the half that needs the test.

Closed in Wave 5: `aliasPosition` is `ahead | behind | unknown`, the read goes through `readOrUnknown` rather
than a catch, both consumers name the third case, and `unknown-collapse-guard` now watches this ledger too —
verified RED by reintroducing the fold.

### R55.7 …and then the effect the guard protected turned out to be WRITE-ONLY
Wave 5 was the right fix for the defect in front of it and the wrong fix for the one underneath it. The alias
promotion could not be made monotonic AT ALL: the position comes from the ledger and the bytes go to an object
store, with no conditional put to join them, so two settlements draining concurrently could still land
newest-first. Two reviews had now guarded a window that is between the read and the put.

What licensed deleting it instead was a fact neither review had checked: the promotion was planned exactly
when staging produced `revisionKey` — the same value the settle records on the revision as `analysisKey` — and
the analysis reader resolves `analysisKey` FIRST. **Every promotion wrote an object its own settlement had
just made unreachable.** `offloadAnalysis`, the alias's only other writer, had lost its last production caller
one review earlier and nobody noticed.

The lesson is about the ORDER of the two questions. Both reviews asked "is this effect correct?" and neither
asked "**does anything read what this effect writes?**" — which is cheaper, and which would have skipped both
guards. Before hardening an effect, resolve its reader; an effect with no reader is deleted, not fenced.

Deleted in Wave 7, with mig 0191 stripping the variant from stored rows. Its counterexample was re-pointed at
the export-receipt projection (the consumer of `settlementPosition` that survives) rather than left to go
vacuous — and its mutation had to change from `ahead` to `behind`, because `ahead` also skips the write and
would have stayed green over a fold that is still wrong.

### R55.8 A lease taken once and held across a network call
`packages/application-control/src/scorecard/publication.ts` — the drain claimed its operation for
`leaseSeconds`, then ran `performEffects` (an HTTP upload of a whole batch's traces to the tenant's
observability platform), then completed. The lease was never touched in between.

L4 had already written the rule — *"a lease held across an external call is renewed while the call runs, or
the lease is not a fence"* — and this was the instance nobody had connected to it, because the lease was
sized for the failure it was named after ("a publisher's process died") rather than for the work it fences.
The moment an export ran longer than that, `listOwed` saw a `claimed` row with an expired lease — the
ledger's own definition of an abandoned drain — and handed the operation to a second publisher mid-upload.
**The row looked abandoned because the work was taking a long time.**

Closed in Wave 8: the drain heartbeats at a third of the lease, stops in a `finally`, and stops on a renewal
that comes back false (a heartbeat may never revive a claim — that would be a second way to take the row).
`renew` is on the port with an owner-and-state guard in both implementations, and the conformance suite asks
both questions, so a third implementation inherits them.

Two things this cost that are worth remembering:
- **The heartbeat belongs to the DRAIN, not to the effect.** Putting it inside `performEffects` would make
  every effect added later responsible for remembering it is fenced.
- **A timing counterexample has to advance the clock in STEPS.** The first draft jumped the whole span at
  once, so a heartbeat that fired exactly once renewed the entire upload and the test passed over the
  mutation that stopped it after one beat. Two of the three mutations written for this wave were green until
  the test interleaved the injected clock with the timer wheel.

### R55.9 An optional field doing two incompatible jobs
`packages/contracts/src/records/publication-operation.ts` — an export effect carried `payloadKey` as
OPTIONAL, with its absence documented as the legacy shape:

> *"Optional for the operations mig 0188 backfilled from the pre-Phase-4 field: they carry a digest and no
> key, and the drain treats them exactly as before."*

It was never only that. `stageAnalysis` froze the payload inside a bare `catch {}` whose comment said the
plan "then carries a digest and no key, which is the pre-Phase-4 behaviour" — so a live settlement whose
object store refused one PUT produced a row byte-identical to one migrated from before the feature existed.

The absent field was answering two different questions with the same silence:
- *"this operation predates payload freezing"* — a statement about our history;
- *"this settlement tried to freeze its bytes and failed"* — an incident on THIS batch.

The drain took the weaker path for both (re-read the live plane, compare, refuse on mismatch), which is
fail-closed and cannot converge once anything re-scores. Nothing said which had happened, or why. Rule `suite`
had already written the answer for this shape — *absence is not a legacy allowance* — and it applies to a
degradation that a LIVE path can produce, not only to old rows.

Closed in Wave 9: `payload` is a required union, `frozen{key}` or `unfrozen{reason}`; the staging seam reports
the failure it used to swallow; the planner REFUSES a settlement that owes an export and never staged one at
all (defaulting to `unfrozen` there would put the escape hatch back one layer down wearing a name); mig 0192
converts stored rows both ways and was verified by re-reading them through the production store.

Two things worth carrying forward:
- **A conditional spread defeats excess-property checking.** `payloadKey` was built in `planPublication`,
  whose return type is `PublicationPlan` — a schema that never declared the field. It travelled at runtime for
  two reviews while the type said it did not exist, which is precisely the hazard rule `typescript` names. The
  union is now declared ONCE in contracts and imported by both ends.
- **Making an optional required is a migration, not a type change.** The compiler found ten fixtures; only
  real rows in a real database found the rest, and "the migration ran" is not "the rows it wrote parse".

---

## What review 54 actually cost to fix — the lessons the phases added

Recorded because each one changed how the NEXT change should be made, not just what the code says.

### A protocol only exists where it is REQUIRED, not where it is offered
Phase 1's shape is the template: the store returns `PersistedWorkIntent`, the reservation hook returns it, and
`requireReservation` refuses to submit without it. The version before it had the right ORDER and no proof, and
those are indistinguishable from inside the backend — a hook that resolved having written nothing looked
exactly like a durable reservation. When a rung cannot be observed from where the decision is made, move the
value, not the comment.

### A comment can outlive the ordering it describes
`recordWork` defended its swallow with "the alternative is failing a dispatch that already succeeded". That
was true while the stamp ran AFTER the apply. Wave A moved it before; the justification did not move with it,
and it read as current for a whole review. **When you reorder a path, re-read every comment that justified the
old order** — they are now claims about a program that no longer exists.

### Fixing one lane exposes the same defect in its twin
Every phase found a second instance the review had not named: the batch planner had the standalone run's
`.catch(() => [])`; the scorecard teardown had the run's missing re-probe; `InMemoryCancellationStore.request`
had erased the counter its Pg twin preserved. **After fixing a collapse, grep for the same idiom in the sibling
lane before closing the phase.**

### A store's two implementations diverging is a protocol defect, not a test gap
The in-memory cancellation store forgot `verificationAttempts` on re-request; Postgres kept it. Nothing failed,
because no test exercised the budget through a re-request — the value simply never counted past one. Rule `db`
already says the impls must be interchangeable; that is a PROTOCOL requirement when a decision reads the value.

### The mutation runner earns its keep by refusing
Twice in this program a phase rewrote a line an older mutation targeted, and the runner failed with "the line
to mutate is gone" rather than passing. That is the whole design: a mutation that matches nothing tests
nothing. Re-anchor it in the same change that moved the line.

### A counterexample can be RIGHT about the defect and WRONG about the shape
#17 asserted `state === "unverifiable"` after a spent budget, following the review's framing. The phase then
concluded that a terminal state there is itself the defect — it removes a live-compute debt from the only loop
that would retry it — so the assertion moved to the invariant (still owed, alert raised, backed off). Changing
a counterexample's assertion is legitimate exactly when the DESIGN moved; say so in the test, or the next
reader cannot tell it from weakening.

### ⚠️ A NUL byte makes a file invisible to grep
A heredoc turned a template literal's space into `\x00` in `scoring-revision.ts`; `file` reported `data` and
every `grep` silently found nothing, so edits appeared to vanish. Second occurrence in this tree. If a change
you just made cannot be found, check `grep -c $'\x00' <file>` before re-editing.

## Cross-cutting: how these survived a green CI

Every one of the above shipped with a green gate, and the gate is not weak — it runs the five commands, the
cone check, `protocol-mutations`, empty-env boot, gitleaks, and a required real-Postgres trust subset.

They survived because the questions were **local**: does the method exist, does the callback fire before the
effect, does the type have three cases. Not: does the zero-row write fail, does the caller branch on the third
case, does the adapter use the key, does the reconciler share the wrapper.

Three suites were additionally **vacuous** (see `verification.md`): counterexample #9 asserted a function was
not called after that function was deleted; counterexample #18 fed the production receipt builder a score whose
metric it ignores, so it asserted properties of `[]`; two scanner drafts were green over the very defect they
were written for. `protocol-mutations` caught the first. Nothing caught the second — the review did.
