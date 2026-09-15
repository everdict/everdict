---
kind: wiki
title: "Grader & Judge"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/execution/grader.ts, packages/contracts/src/execution/eval-case.ts, packages/graders/src/make-graders.ts, packages/graders/src/script-grader.ts, packages/contracts/src/harness/judge-spec.ts]
---
# Grader & Judge

A run produces evidence. A grader turns evidence into a **measurement**:

```json
{ "id": "tests-pass", "config": { "cmd": "pytest -q" } }
```

That runs in the finished environment and emits a score:

```json
{ "graderId": "tests-pass", "metric": "tests_pass", "value": 1, "pass": true }
```

A judge does the same job for output that has no checkable shape — chosen at submit time, not baked
into the dataset:

```bash
curl -XPOST localhost:8787/scorecards \
  -H 'content-type: application/json' -d '{
  "dataset": { "id": "support-replies", "version": "latest" },
  "harness": { "id": "my-agent", "version": "latest" },
  "runtime": "local",
  "judges":  [{ "id": "tone-rubric", "version": "latest" }]
}'
```

Each judge contributes its verdict under the metric `judge:<id>`, and one `judge:<id>:<criterion>` per
criterion it declares.

## Which one to reach for

Deterministic first, always. `tests-pass` running your real test suite is worth more than any rubric,
because it has one right answer and adds no variance of its own.

```json
[
  { "id": "tests-pass", "config": { "cmd": "pytest -q" } },
  { "id": "cost" },
  { "id": "steps" }
]
```

Other built-in graders include `command` (a command with a pass pattern or custom metric),
`script-score` (a numeric score a script prints), `state-check`, `answer-match`, `latency`,
`dom-contains` and `url-matches`.

Use a judge when the thing you care about genuinely cannot be checked — prose quality, whether a plan
is sound, whether a screenshot shows the right screen. Judges come in three kinds: a `code` judge runs
your Python or Node script over the case, trace and snapshot (and may call a model); a `model` judge
calls an LLM or VLM with a rubric, through a model registered in your workspace or a raw model name; a
`harness` judge delegates to an actual agent and takes the verdict from *its* trace.

:::warning
Every judge you add is another source of variance in the number you are about to compare week over
week. Two judges disagreeing is information; five judges averaged is noise with a decimal point.
:::

## A Score is not a number with optional fields

This is the part worth reading twice, because it is where most eval tooling quietly lies.

`Score` is a **discriminated union on `status`**. A measured score carries a value:

```json
{ "graderId": "tests-pass", "metric": "tests_pass", "value": 1, "pass": true }
```

A non-measurement carries **no value at all** — only a reason, and whether re-scoring can recover it:

```json
{ "graderId": "tone-rubric", "metric": "judge:tone-rubric",
  "status": "unmeasured", "reason": "missing_secret", "retryable": true }
```

The reasons are closed: `grader_error`, `grader_timeout`, `missing_evidence`, `missing_secret`,
`unsupported`, `policy_skip`. A grader that *returns* something the contract forbids (a `NaN` value, an
empty id) gets its own status, `invalid`, with reason `contract_violation`.

The shape *is* the enforcement. When a non-measurement has no `value` field, a dead grader has no `0`
to leak into a mean, and code that reads `.value` without narrowing **fails to compile**. Before this,
the flat shape let a broken grader average in as a zero — which reads as "the agent scored badly" when
the truth was "we did not measure."

So when you see an unmeasured score, the question is never "why did it score low". It is "why was
nothing measured", and the reason tells you: `missing_secret` is re-scorable once you configure the
key (`POST /scorecards/:id/rescore-unmeasured`); an `invalid` score is a bug in the grader and is never
retried.

## Writing your own

A grader is named by a spec, so a case declares scoring without depending on grader code. The `script`
grader runs your own Python or Node code:

```json
{ "id": "script", "config": { "id": "business-check", "language": "python", "entrypoint": "check.py" } }
```

The script receives the serialized grading context (case, trace, snapshot) as its first argument and
prints a Score JSON as the last thing on stdout; `config.code` takes inline source instead of
`entrypoint`. Note that three different names are in play — the implementation (`script`), the check
(`business-check`) and the metric it emits (`quality`). Say the last one explicitly:

```json
{ "id": "script",
  "config": { "id": "business-check", "language": "python", "entrypoint": "check.py" },
  "metrics": [{ "id": "quality", "direction": "higher_is_better" }] }
```

Without `metrics`, a declaration made under the id `script` composes policy for a metric nothing ever
emits, while the score that actually lands carries no declared semantics at all. The declaration and
the measurement end up being about different names.

## Who gets to define "passing"

A grader can declare that its metric is **ground truth** — the thing a verdict ultimately rests on:

```json
{ "id": "script",
  "config": { "language": "python", "entrypoint": "check.py" },
  "metrics": [{ "id": "quality", "authority": "ground_truth" }] }
```

That declaration is **admin-only at submit**. Whoever can name new ground truth can decide what passing
means, and that power is reviewed rather than ambient. A custom grader gains authority by *declaring*
it, never by an edit to domain code — which is what makes a grader ecosystem possible without making
the verdict meaningless.

## See also

- [Verdict](verdict.md) — how scores become pass or fail
- [`../../judges.md`](../../judges.md) — registering and versioning Agent Judges
- [`../../architecture/judge-input-contract.md`](../../architecture/judge-input-contract.md) — declare, preview, dry-run
