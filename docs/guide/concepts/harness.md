# Harness

A **harness is the agent under test**, driven over a process boundary. Everdict never links your agent
into its own process — it starts it, feeds it a task, and reads back what it did.

That boundary is the whole reason Everdict can be harness-agnostic: anything that can be started and
observed can be evaluated, whether or not it was written with evaluation in mind.

## Three kinds

`HarnessSpec` is a discriminated union on `kind`:

| Kind | What it is | When you use it |
| --- | --- | --- |
| **`process`** | a coded adapter — `ClaudeCodeHarness`, `ScriptedHarness` | the agent needs real integration logic |
| **`command`** | a *declaration*: an executable, its arguments, and how to read its output | any CLI agent — no code at all |
| **`service`** | a multi-service topology deployed for the run (API + worker + browser + stores) | the agent is a stack, not a binary |

Most agents should be a `command` harness. You write JSON, not an adapter:
[`../../command-harness.md`](../../command-harness.md). For the stack case, see
[`../../service-harness.md`](../../service-harness.md).

## Template and instance

A harness has two levels, and mixing them up is the most common early confusion:

- A **`HarnessTemplate`** is the structural skeleton — the kind, the shape, the *slots* it exposes.
  It gets a new version only when the shape changes.
- A **`HarnessInstance`** is a template reference plus **pins** (slot → concrete value: an image ref, a
  model) and optional overrides. Conventionally one instance per pull request or commit.

The engine sees neither. It consumes the **resolved `HarnessSpec`** that
`resolveHarnessInstance(template, instance)` produces. This is what lets you change the model a harness
runs under without republishing its structure, and what makes "which exact thing did we evaluate" a
question with an answer.

Pins can also be **ephemeral** — supplied at submit time, registry untouched. That is how a CI run
evaluates a candidate image without publishing it; the swap is recorded in the scorecard's
`origin.pinOverrides`, so the record still names what actually ran.

## Versioning

Harnesses live in the registry as `(workspace, id, version)` with **immutable versions**. `latest`
resolves by semver. A workspace owns its harnesses and falls back to `_shared` for the seeded
examples.

Immutability is not bureaucracy here — it is the precondition for the product's core claim. A scorecard
records the version it evaluated; if that version could be edited afterwards, the comparison to the
next scorecard would be meaningless.

## What the harness does *not* do

It does not score itself. The harness produces a trace and a snapshot of the world it changed;
[graders and judges](grader-and-judge.md) turn those into measurements. Keeping scoring outside the
harness is what makes two different agents' numbers comparable.

It also does not choose where it runs. That is the [runtime and the backend](run.md#where-a-run-goes).

## Trace normalization

Each harness knows how to turn its own native output into the platform's `TraceEvent` stream — Claude
Code's stream-JSON, a CLI's stdout, an OTel span export. Downstream, everything reads the normalized
form, which is why a judge written once works across agents.

Cost and token counts come from the harness's own trace (Claude reports `total_cost_usd`, for example)
rather than being estimated. When the harness runs under `LocalDriver` it uses the machine's existing
login — no API key needed.

## Where this shows up next

- [`../../command-harness.md`](../../command-harness.md) — bring any CLI agent, no code
- [`../../service-harness.md`](../../service-harness.md) — multi-service topologies
- [`../../architecture/harness-taxonomy.md`](../../architecture/harness-taxonomy.md) — template/instance in full
- [`../../registry.md`](../../registry.md) — the versioned SSOT
