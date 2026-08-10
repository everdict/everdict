# Verdict

The verdict is the product. Everything else — harnesses, runtimes, traces — exists to make this one
value defensible.

## A case verdict has three states, not two

`caseVerdict(result, policy)` returns `boolean | undefined`:

- **`true`** — evaluated, and it passed.
- **`false`** — evaluated, and it failed.
- **`undefined`** — **not evaluated.** Nothing measured the thing the verdict would rest on.

The third state is the one that matters. A case whose grader threw, whose evidence was never captured,
or whose required secret was missing did not pass. It also did not fail. Collapsing it into either is
how eval tooling produces confident nonsense.

**Absence is never green.** A release gate, a CI check, a dashboard tile — every surface that reads a
verdict treats "not evaluated" as not-passing, and says so in its own words rather than rounding it to
a pass.

## The policy is stamped, not assumed

What counts as passing is a **verdict policy**, composed at submit time from the graders in play and
stamped onto the scorecard with a digest.

Two consequences:

- The rules travel with the result. Reading a six-month-old scorecard tells you what "pass" meant *then*,
  not what it would mean if you re-derived it today.
- A stale aggregate is detectable. `verdictSummaryOf` is the persisted twin of the computed pass rate,
  stamped with the policy digest — if the two disagree, that is a fact you can observe rather than a
  silent wrong number.

A custom grader gains authority over a metric by **declaring** it in its spec, never by an edit to
domain code. Declaring **ground truth** — the metric a verdict ultimately rests on — is admin-gated at
submit, because that is the power to define what passing means.

## Why the aggregate is not just "pass / total"

`verdictSummaryOf` counts passed and failed **among cases that produced a verdict at all**, and the
pass rate is **absent** when nothing was verdicted. A rate over nothing is absence, not zero, and the
record says so.

Every release-shaped surface — product readiness, the timeline, dashboards — reads this same summary
rather than computing its own headline. That is deliberate: the number a release stands on and the
verdict a case dialog shows can never rank differently.

## One case is not one datapoint

With `trials: N`, a case is attempted N times, and the verdict for that case becomes a statistical
question: pass@k, and a flakiness signal when the trials disagree. An agent that passes 3 of 5 attempts
has not "passed" — and a comparison between two versions has to account for the noise floor before
calling a difference real.

## The invariants are tested, nightly

The claims on this page are not conventions someone is expected to remember. They are pinned by the
**trust certification suite** — a nightly run of invariant tests over the whole evaluation path, whose
output is a plain `PASS` or a failure naming the invariant that broke.

If you want to know whether to believe a verdict this system produced, that suite is the thing to read:
[`../../trust-certification.md`](../../trust-certification.md).

## Where this shows up next

- [Grader & Judge](grader-and-judge.md) — where measured and unmeasured scores come from
- [Scorecard](scorecard.md) — the manifest seal and the scoring ledger
- [`../../trust-certification.md`](../../trust-certification.md) — the nightly invariant suite
- [`../../architecture/trial-based-verdict.md`](../../architecture/trial-based-verdict.md) — pass@k, flakiness, statistical regression
