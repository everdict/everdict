# Grader & Judge

A run produces evidence. A **grader** turns evidence into a **measurement**. That measurement is a
`Score`, and the rules around it are stricter than they first look — deliberately, because a number
nobody can defend is worse than no number.

## Grader

A grader reads the run's trace, its environment snapshot, and the case, and emits scores. Everdict
ships several families:

| Family | What it measures |
| --- | --- |
| **outcome** | did it work — `tests-pass` runs a command in the finished environment |
| **cost / steps / latency** | efficiency, from the harness's own trace |
| **trace** | properties of how it worked (tool sequences, milestones) |
| **browser / OS** | the state of the world at the end |
| **model** | an LLM/VLM judgment — see below |

Graders are named by a `GraderSpec` — `{ id, config }` — so a case declares scoring without depending
on grader code. `id` selects the implementation; `config` parameterizes it (`tests-pass` takes a `cmd`).

Crucially, the grader is **not part of the harness**. Two different agents solving the same case are
scored by the same code, which is the only reason their results are comparable at all.

## Judge

An **Agent Judge** is a registered, versioned judgment applied to a trace *after* the run. Two kinds:

- **`model`** — call an LLM or VLM with a rubric and read back a verdict, using the workspace's own
  provider key.
- **`harness`** — delegate to an actual agent and take the verdict from *its* trace.

Judges are chosen at submit time (`judges[]`), not baked into the dataset, and each one contributes
scores under `judge:<id>`. Because they are registry documents, the exact judge version — and the model
closure it ran under — is sealed into the scorecard. "We re-ran the judge and got a different answer"
is therefore a detectable event rather than a mystery.

## A Score is not a number with optional fields

This is the part worth reading twice. `Score` is a **discriminated union on `status`**:

- A **measured** score carries a `value` (and `pass`).
- An **unmeasured** score carries **no value at all** — only a reason.

The reasons are a closed vocabulary:

| Reason | Meaning |
| --- | --- |
| `grader_error` | the grader threw while scoring |
| `missing_evidence` | the trace or snapshot it needed was never captured |
| `missing_secret` | a required credential was absent — re-scorable once configured |
| `unsupported` | this deployment cannot run that grader |
| `policy_skip` | deliberately skipped by configuration — not an error |
| `contract_violation` | the grader returned something illegal (NaN, empty ids) — a grader bug, never retried |

The shape is the enforcement. When a non-measurement has no `value` field, a dead grader has no `0` to
leak into a mean, and code that reads `.value` without narrowing **fails to compile**. Before this, the
flat shape let a broken grader quietly average in as a zero — which reads as "the agent scored badly"
when the truth is "we did not measure."

## Who is allowed to define "passing"

A grader can *declare* the semantics of the metric it produces — including that its metric is
**ground truth**, the thing a verdict ultimately rests on. That declaration is
**constitution-gated: admin-only at submit.** Whoever can name new ground truth can decide what passing
means, and that power is reviewed rather than ambient.

A grader also declares its metrics separately from its identity. `id: "script"` with
`config.id: "business-check"` emitting `metric: "quality"` is three different names; the spec's
`metrics[]` says which ones the declared semantics actually apply to, so a policy is never composed for
a metric nothing emits.

## Where this shows up next

- [`../../judges.md`](../../judges.md) — registering and versioning Agent Judges
- [Verdict](verdict.md) — how scores become a pass/fail
- [`../../architecture/judge-input-contract.md`](../../architecture/judge-input-contract.md) — declare, preview, dry-run
