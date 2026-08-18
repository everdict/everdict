# Verification — proving that a test proves something

Green means "the suite's questions were answered". It does not mean the invariant holds. This file is the
discipline that closes the gap, written from three suites that were green over the gap they were built to close.

## The order (non-negotiable for a protocol change)

1. **Plant the counterexample and SEE IT RED.**
   Write the assertion against today's code, run it, and copy the **observed failure text** into the test's
   header comment: `// RED as of <sha>: <message>`.
2. **Check the red for the right reason.** Red because a fixture field is missing, an import is wrong, or a
   helper threw proves nothing about the invariant. If the message does not describe the defect, the fixture
   is wrong — fix the fixture, not the assertion.
3. **Make the change.** Un-skip / flip the counterexample to green.
4. **Neutralize the protocol and require RED.** `pnpm protocol-mutations` — it edits one production file to
   remove the protocol, runs the owning suite, requires red, and reverts in a `finally`. Add the mutation for
   your new protocol in the same change. A mutation whose target line no longer exists **fails**, so a deleted
   subject can never silently stop being tested.
5. **Delete the escape hatch** (see rule `protocol` L1–L5). Then `pnpm ci:local`, then push, then confirm green.

## The three ways a test goes vacuous

### A. The assertion outlives its subject
Counterexample #9 asserted *"the teardown does not call `killCase`"*. The legacy-removal change deleted
`killCase`. The assertion became trivially true and the suite stayed green over an unprotected path.
`protocol-mutations` caught it — the Wave A.5 mutation reported "stayed GREEN".

> After any deletion or rename, re-run the mutation suite. A refactor that makes an assertion unreachable is a
> lost test, not a passing one.

### B. The fixture never reaches the predicate
Counterexample #18 was built the right way — from the production builder, deliberately, with a comment saying
a hand-built fixture *"would be asserting against a shape no production path produces"*. Its score was
`{ graderId: "judge:a", metric: "quality" }`. The builder only reads metrics starting with `judge:`, so it
returned `[]`, and the test asserted `toBeDefined()` — which `[]` satisfies. The test certified that an empty
receipt vector counts as recorded provenance.

> Using the production builder is necessary and not sufficient. **Assert cardinality**: `toHaveLength(n)` on
> anything derived, and never `toBeDefined()` on a collection. If the fixture's inputs do not exercise the
> predicate, the fixture is decorative.

### C. The guard is green over its own target
Two structural scanners were first written in a form that passed against the code they were written to refuse.

> Revert the production line the guard targets, watch the guard go RED, restore. A guard nobody saw fail is a
> comment with a test runner attached.

## A protocol between two actors needs an INTERLEAVED counterexample

Every counterexample in the first two programs drove ONE actor through a sequence. That is enough to pin an
ordering ("the handle is reported before the object exists") and it cannot reach the defect class that made the
third review: **two actors racing across the gap between a check and the effect it guards.** Nine of the ten
open findings at `63194486` are that shape, and the mutation suite was green on all of them.

The shapes, so they can be recognised rather than rediscovered:

| Interleaving | The window | What a sequential test sees |
|---|---|---|
| cancel / takeover between `reserve()` and `submit()` | the guard checked liveness, then the world changed | a clean dispatch |
| two publishers between `aliasIsAhead()` and `put()` | both read "nobody is ahead", both write | correct ordering |
| retry after a FAILED kill | the first attempt terminalized the row it was iterating | a converged teardown |
| a second dispatch onto one attempt | last-write-wins on the column naming live compute | one handle |
| a judge retry vs the finalizer's receipt | the emitter moved; the reconstruction did not | matching counts |

Write them as: **A acts to the point of no return → B acts → A completes.** Drive both explicitly (resolve a
held promise, call the two drains in an interleaved order, mutate the row between the read and the write) —
`Promise.all` over two calls proves nothing, because nothing forces the schedule.

> A rung whose defect needs two actors needs two actors in its test. If the counterexample can be written as
> one call after another, it is not testing the rung you think it is.

## A type-level counterexample cannot be planted and skipped

`describe.skip` suppresses the RUNTIME, not `tsc`. A counterexample whose claim is about a CONTRACT — "this
field must exist on the public type" — breaks `pnpm typecheck` the moment it is written, so it cannot sit in
the tree waiting for its phase. Its change and its proof land in the same commit.

Worse, the runtime half of such a test is usually **vacuous in the other direction**. Excess-property checking
applies to object literals only, so an undeclared field passed through a narrower parameter type is still on
the object at runtime: asserting `ctx.idempotencyKey === "…"` after the hop PASSES today, over the very gap it
was written for. The honest assertion is the type one, and it belongs in the phase that fixes it.

> Before planting a counterexample, ask which layer the claim lives in. Runtime claim → plant it skipped with
> its observed red text. Type claim → schedule it; do not weaken it into a runtime claim that passes.

## What a good fixture asserts

For any derived collection (receipts, outcomes, handles, effects):
- **cardinality** — `toHaveLength(expected)`, from the inputs, not from the output
- **identity** — the join key equals the one the *other* side mints (e.g. a receipt's `evidenceEmitter` equals
  the emitter the evidence plane actually carries; build both with their production functions and compare)
- **the negative** — one input the predicate must ignore, proving the filter is a filter and not a no-op

## Layer-specific notes
- **Postgres semantics that matter to a protocol** (zero-row updates, claim/lease expiry, CTE snapshot
  visibility) are NOT provable against the fake `SqlClient` — that asserts SQL text. Put them in
  `apps/api/src/trust/*.trust.test.ts`, which runs against a real database and is a required check
  (`trust fast (real Postgres)`); `pnpm ci:local` deliberately boots no database and cannot pre-run it.
- **`apps/api` trust scenarios that boot the built artifact** (e.g. TRUST-127 spawns `apps/api/dist/main.js`)
  need `pnpm build --filter @everdict/api` first — a source-only fix runs the old binary and reports red.
- **Adapter semantics** (what Nomad answers on a 5xx, what K8s answers on a 404) belong in the shared
  conformance suites, and the assertion must be about the ANSWER, not the method's existence.
- **An empty `describe(...)`** fails with "No test found in suite" — and only in a full run. Delete the shell.

## Deciding between a type, a guard, and a test
1. **Type** — can the wrong line be made unrepresentable? (union instead of optional+boolean; required proof
   parameter instead of optional hook.) Do this. It needs no maintenance and cannot be allowlisted.
2. **Test / conformance suite** — can the wrong behaviour be observed from outside? Assert the answer.
3. **Structural guard (scanner)** — last resort, for shapes the type system cannot see (a re-added method
   name, a swallow idiom). Every allowlist entry is an admission that 1 was skipped; the entry must state why
   that caller does not decide anything.
