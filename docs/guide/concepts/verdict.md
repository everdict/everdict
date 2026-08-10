# Verdict

The verdict is the product. Everything else — harnesses, runtimes, traces — exists to make this one
value defensible.

It has three states, not two:

```ts
caseVerdict(result, policy)  // → true | false | undefined
```

- **`true`** — evaluated, and it passed.
- **`false`** — evaluated, and it failed.
- **`undefined`** — **not evaluated.** Nothing measured the thing the verdict would rest on.

```
          scores for a case
                 │
        did anything measure it?
         ┌───────┴────────┐
        no                yes
         │                 │
    undefined      meets the stamped policy?
  "not evaluated"    ┌─────┴─────┐
         │          yes          no
         │           │            │
         │         true         false
         │        passed        failed
         ▼
  gates · charts · releases → NOT green
```

## The third state is the whole point

A case whose grader threw, whose evidence was never captured, or whose required secret was missing did
not pass. It also did not fail. Collapsing it into either is how eval tooling produces confident
nonsense.

Consider a batch of 100 cases where the judge's API key expired halfway through:

```json
{ "verdictSummary": { "passed": 41, "failed": 9, "verdicted": 50, "passRate": 0.82 } }
```

Fifty cases produced no verdict at all. The pass rate is **0.82 over the 50 that were measured**, not
0.41 over 100 — and the summary says so rather than quietly averaging the unmeasured half as zeros.
Had it done that, the number would read 0.41 and every human looking at it would conclude the agent
got worse.

**Absence is never green.** A release gate, a CI check, a dashboard tile — every surface that reads a
verdict treats "not evaluated" as not-passing, and says so in its own words rather than rounding it to
a pass.

:::warning
`passRate` is **absent**, not zero, when nothing was verdicted. A rate over nothing is absence. Code
that defaults it to `0` reintroduces exactly the bug the three-state verdict exists to prevent.
:::

## The policy is stamped, not assumed

What counts as passing is a **verdict policy**, composed at submit time from the graders in play and
stamped onto the scorecard with a digest.

Two consequences worth internalizing:

The rules travel with the result. Reading a six-month-old scorecard tells you what "pass" meant then,
not what it would mean if you re-derived it today against a policy that has since changed.

A stale aggregate is detectable. `verdictSummaryOf` is the persisted twin of the computed pass rate,
stamped with the policy digest — if the two disagree, that is a fact you can observe rather than a
silently wrong number on a dashboard.

A custom grader gains authority over a metric by **declaring** it, never by an edit to domain code.
Declaring **ground truth** — the metric a verdict ultimately rests on — is admin-gated at submit,
because that is the power to define what passing means.

## One case is not one datapoint

```json
{ "trials": 5 }
```

With trials, a case's verdict becomes a statistical question: pass@k, and a flakiness signal when the
trials disagree. An agent that passes 3 of 5 attempts has not "passed".

And a comparison between two versions has to clear the noise floor before you call the difference real.
Measure the noise first — run the same version twice and look at the spread — then decide what size of
movement you are willing to believe. A single run moving a point or two is usually the dice.

## Everything above is tested, nightly

These are not conventions someone is expected to remember. They are pinned by the **trust
certification suite**, which runs every night over the whole evaluation path and emits a plain `PASS`
or the name of the invariant that broke.

If you want to know whether to believe a verdict this system produced, that suite is the artifact to
read: [`../../trust-certification.md`](../../trust-certification.md).

## See also

- [Grader & Judge](grader-and-judge.md) — where measured and unmeasured scores come from
- [Scorecard](scorecard.md) — the manifest seal and the scoring ledger
- [`../../architecture/trial-based-verdict.md`](../../architecture/trial-based-verdict.md) — pass@k, flakiness, statistical regression
