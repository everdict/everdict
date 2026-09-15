---
kind: wiki
title: "Budgets & cost"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/billing/budget.ts, apps/api/src/api/billing/billing.routes.ts, apps/api/src/common/budget-tracker.ts, apps/api/src/api/scorecard/request/run-scorecard.ts]
---
# Budgets & cost

Evaluation spends money on a timer. A nightly 400-case scorecard with two model judges is a nightly
provider bill, and the first surprise usually arrives as an invoice rather than an alert.

## Where the cost comes from

Three places, and they are not equally visible:

**The agent under test** — unless it runs on a personal self-hosted runner, where the machine's own
login pays. That is the single largest lever: `runtime: "self:<id>"` moves agent spend off the workspace
(calls made with a workspace-registered model are still the workspace's).

**Judges** — every `model` judge is a provider call per case per trial. Three trials with two judges is
six calls per case.

**Trials** — the multiplier on everything above. `trials: 5` is five times the agent cost.

## What is recorded

Cost and tokens come from the harness's own trace, not an estimate. Claude reports `total_cost_usd`;
a usage-proxy sidecar recovers per-run token usage for gateways that do not.

Every run carries its own cost, so a scorecard's cost is the sum of things you can inspect
individually — not a number you have to trust.

## Two instruments: the meter and the budget

**The usage meter** (`GET /usage`) records the workspace's metered LLM cost — agent, judge and
workspace-agent conversations — and never blocks anything.

**The budget** (`GET /budget`, and `PUT /budget` for an admin; **Settings → Budget**) sets caps per
workspace on cost (`usd`), `tokens` and `runs`. Any cap left unset is unlimited, and a workspace with no
limit falls back to the operator's `EVERDICT_TENANT_USD` / `EVERDICT_TENANT_RUNS` if those are set.

:::warning
A budget **refuses**. Once a cap is reached, new work is rejected with `402 BUDGET_EXCEEDED` — a run,
a file execution, a browser session, and **each remaining case of a batch already under way**, which then
fails. Cost is only known after a run, so the last run that crosses the cap is allowed to finish.
:::

That is a real trade: a batch stopped at 60% is a failed scorecard, not a cheaper complete one. So set
caps as a backstop against runaway spend, and keep the control you actually want upstream:

- **`cases`** — run a subset (`limit`, `tags` or explicit `ids`) nightly and the full dataset weekly.
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

Nightly, that is 36,000 model calls a month before anyone runs anything by hand. If those numbers look
fine, run it nightly. If they do not, the answer is a nightly subset and a weekly full run — not a
smaller model for the judge, which trades money for a noisier verdict.

## See also

- [Schedules & monitoring](schedules.md) — the thing that turns cost into a recurring cost
- [Runtime](../concepts/runtime.md) — `self:<id>` and who pays
- [`../../usage-metering.md`](../../usage-metering.md) · [`../../architecture/usage-metering.md`](../../architecture/usage-metering.md)
