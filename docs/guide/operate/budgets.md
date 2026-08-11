# Budgets & cost

Evaluation spends money on a timer. A nightly 400-case scorecard with two model judges is a nightly
provider bill, and the first surprise usually arrives as an invoice rather than an alert.

## Where the cost comes from

Three places, and they are not equally visible:

**The agent under test** — unless it runs on a self-hosted runner, where the machine's own login pays.
That is the single largest lever: `runtime: "self:<id>"` moves agent spend off the workspace entirely.

**Judges** — every `model` judge is a provider call per case per trial. Three trials with two judges is
six calls per case.

**Trials** — the multiplier on everything above. `trials: 5` is five times the agent cost.

## What is recorded

Cost and tokens come from the harness's own trace, not an estimate. Claude reports `total_cost_usd`;
a usage-proxy sidecar recovers per-run token usage for gateways that do not.

Every run carries its own cost, so a scorecard's cost is the sum of things you can inspect
individually — not a number you have to trust.

## Budgets are meter-only

:::warning
A workspace budget **records** spend. It does not refuse it. Nothing in the platform will stop a batch
halfway because it got expensive.
:::

That is a deliberate choice — a batch killed at 60% produces a partial scorecard, which is worse than
an expensive complete one, because a partial result that looks complete is how wrong decisions get
made. But it means the budget is a *reporting* tool, and the control you actually have is upstream:

- **`subset`** — run 40 cases nightly and the full 400 weekly.
- **`trials`** — three is usually enough to see flakiness; five rarely tells you more.
- **Judges** — prefer deterministic graders. Every judge you add is both variance and spend.
- **`self:<id>`** — move agent spend to a machine whose subscription already exists.
- **Schedules** — a cron you forgot is the most expensive thing here. Audit them.

## A worked estimate

A 200-case dataset, 3 trials, one model judge:

```
agent calls  = 200 × 3            = 600
judge calls  = 200 × 3 × 1        = 600
```

Nightly, that is 42,000 model calls a month before anyone runs anything by hand. If those numbers look
fine, run it nightly. If they do not, the answer is a nightly subset and a weekly full run — not a
smaller model for the judge, which trades money for a noisier verdict.

## See also

- [Schedules & monitoring](schedules.md) — the thing that turns cost into a recurring cost
- [Runtime](../concepts/runtime.md) — `self:<id>` and who pays
- [`../../usage-metering.md`](../../usage-metering.md) · [`../../architecture/usage-metering.md`](../../architecture/usage-metering.md)
