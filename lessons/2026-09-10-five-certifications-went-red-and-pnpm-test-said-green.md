# Five certifications went red, and `pnpm test` said green

Date: 2026-09-10
Found by: running `trust-fast` by hand, because a review document declared it as a limit

## What was believed

That the measurement-identity change was done. It had counterexamples, a full `pnpm test`, `pnpm ci:commits`
over every commit, `pnpm review`, `pnpm ci:local`, and it shipped. The belief was that a change adding an
OPTIONAL field to a value cannot break a reader — nothing is removed, and every consumer that does not ask
still gets what it got.

That is true of consumers. It is not true of ASSERTIONS. `sanitizeScore` began stamping `measurement` on every
score at the collection boundary, and five trust scenarios assert a whole `Score` with `toEqual` — the shape
grew a fourth key and each one went red. A sixth read further: `Run.succeed` sanitizes inside the transaction,
so a fixture that digests a raw literal into a receipt and stores the sanitized document produced a receipt
whose digest names bytes the row will never hold. `case-outcome-committer.ts` already had a comment saying
exactly that would happen — "asking it only there would seal a receipt over the bytes a producer submitted and
store the bytes the platform accepted" — and the fixture beside it was doing it.

## What made it invisible

`*.trust.test.ts` gates on `process.env.EVERDICT_TRUST_SUITE === "1"`. Locally that is unset, so **the files
do not run and vitest reports them as skipped, and `pnpm test` is green**. `pnpm ci:local` deliberately boots
no Postgres, so it is green. `pnpm ci:commits` runs the same suite per commit, so it is green nine times over.
The one thing that runs them is `trust-fast`, which is a GitHub Actions workflow — and every workflow in this
repository has been `disabled_manually` since 2026-08-21 (declared-limits C3).

So the required check that owns these scenarios has not run since August, the local gate cannot substitute for
it by design, and nothing anywhere says how long it has been since anything did. `.claude/rules/ci.md` has
carried the warning the whole time — *"a trust scenario that SKIPS is not a passing one, and locally that is
the default"* — and prose is what it was.

## What would have caught it earlier

The cheapest thing: `pnpm ci:local` printing how many `*.trust.test.ts` scenarios it did NOT run, and when the
suite last ran green. Not running them — that needs three containers and is the choice this repository already
made — but refusing to let "skipped" and "passed" look alike in the summary a person actually reads. Zero
model calls, no infrastructure, and it would have said "286 scenarios not certified since 2026-08-21" on every
push that shipped this.

Not: remembering to run `trust-fast` after touching a scored value, which is what the rule already asks for and
what did not happen.

## What was done about it

Eval case: none — the failure is a suite that silently does not run, which no prompt replay can observe; the
honest repair is a counter in the gate's own output, and the gap is declared until it exists.

The six scenarios were repaired to the shape production actually produces, and each one now ASSERTS the
stamped identity rather than tolerating it — a scenario that lets the field float has stopped certifying the
thing that makes a metric name safe to carry. `trust-fast` was then run in full: 439 executed, 0 failed.

**The counter shipped on 2026-09-11 as `pnpm trust-certified`**, wired into `ci:local`. It prints the scenario
count in the required check's scope, the last certification's sha and date, and which files in that scope have
changed since — `trust-suite.mjs` writes `.git/everdict-trust-ok` on PASS only, so a failed or skipped run
never moves the marker forward. It reads the scope OUT of `trust-fast.yml` rather than keeping a second copy,
and that is the one thing it is red about: a count over the wrong population is worse than no count.

It does not run the scenarios and does not fail on them, deliberately — three containers inside the push gate
is the cost this deployment declined, and a gate needing infrastructure it cannot start teaches people to
bypass gates. ⚠️ **So this is the fallback, and shipping it is what records that C3 STAYS**
(`docs/architecture/harness-declared-limits.md`). The repair is still `gh workflow enable`, and it is one
command per workflow.
