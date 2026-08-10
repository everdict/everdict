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
  "judges":  [{ "id": "tone-rubric", "version": "latest" }]
}'
```

Each judge contributes scores under `judge:<id>`.

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

Use a judge when the thing you care about genuinely cannot be checked — prose quality, whether a plan
is sound, whether a screenshot shows the right screen. A `model` judge calls an LLM or VLM with a
rubric using your workspace's own provider key; a `harness` judge delegates to an actual agent and
takes the verdict from *its* trace.

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

A non-measurement carries **no value at all** — only a reason:

```json
{ "graderId": "judge:tone-rubric", "metric": "tone",
  "status": "unmeasured", "reason": "missing_secret" }
```

The reasons are closed: `grader_error`, `missing_evidence`, `missing_secret`, `unsupported`,
`policy_skip`, `contract_violation`.

The shape *is* the enforcement. When a non-measurement has no `value` field, a dead grader has no `0`
to leak into a mean, and code that reads `.value` without narrowing **fails to compile**. Before this,
the flat shape let a broken grader average in as a zero — which reads as "the agent scored badly" when
the truth was "we did not measure."

So when you see an unmeasured score, the question is never "why did it score low". It is "why was
nothing measured", and the reason tells you: `missing_secret` is re-scorable once you configure the
key; `contract_violation` is a bug in the grader and is never retried.

## Writing your own

A grader is named by a spec, so a case declares scoring without depending on grader code:

```json
{ "id": "script", "config": { "id": "business-check", "cmd": "./check.sh" } }
```

The script prints a score line; the id in `config` names *which* check this is. Note that three
different names are in play — the implementation (`script`), the check (`business-check`) and the
metric it emits (`quality`). Say the last one explicitly:

```json
{ "id": "script",
  "config": { "id": "business-check", "cmd": "./check.sh" },
  "metrics": [{ "id": "quality", "direction": "higher_is_better" }] }
```

Without `metrics`, a declaration made under the id `script` composes policy for a metric nothing ever
emits, while the score that actually lands carries no declared semantics at all. The declaration and
the measurement end up being about different names.

## Who gets to define "passing"

A grader can declare that its metric is **ground truth** — the thing a verdict ultimately rests on:

```json
{ "id": "script", "config": { "cmd": "./check.sh" },
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
