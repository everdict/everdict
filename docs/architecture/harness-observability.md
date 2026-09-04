---
kind: wiki
title: "Harness observability — what the harness can see about itself"
status: current
updated: 2026-09-05
---
# Harness observability — what the harness can see about itself

Everything this repository's gates know, they know about the **code**. This page is the inventory of what
they know about **themselves**, where each fact lives, and which questions still have no answer.

The distinction that organises it: a fact about a **tree** is answerable by reading files, and every check
under `scripts/` does exactly that. A fact about an **act** — a decision that was made, a session that ran —
exists only if something recorded it while it happened.

## The ledgers

They live in `.git/`, and that is deliberate: they describe *this checkout's operations*, not the project's
history. None of them travels with a clone. The one exception is below the table, and it is an exception for
a reason.

| File | Written by | Holds |
|---|---|---|
| `everdict-ci-ok` | `pnpm ci:local`, `pnpm ci:commits` | `<sha> full\|fast` per gated commit |
| `everdict-evals-ok` | `pnpm agent-evals` (full, clean-configuration runs) | the HEAD a green eval run attests |
| `everdict-review-ok` | `pnpm review` (full-range runs) | the HEAD a completed review attests |
| `everdict-review-<head>.json` | `pnpm review` | the findings, ranked, with the range and part count |
| `everdict-scan-log.jsonl` | `pnpm scan` | one line per scan: scope, head, model, file count, findings |
| `everdict-gate-log.jsonl` | `scripts/hooks/pre-push-gate.mjs`, on every push decision | `{at, verdict, arm, head, pushed, configChanged, productChanged, releaseTags, reason}` |

The release authorization is the odd one out: it is the only record here that is COMMITTED rather than kept
in `.git/`. `releases/<tag>.md` has to travel with the tag it authorizes — an authorization that lives
only in a working tree did not authorize anything anyone else can see.

Three of them are **stamps** — `ci-ok`, `evals-ok`, `review-ok` — and they answer "may this proceed". The
gate log is a **record**: it answers "what has this control been doing". A harness with only the first kind can
prove what it permitted and nothing about what it refused, and the refusals are the half that shows a control
was load-bearing rather than decorative.

### Arms, not prose

Each logged decision carries an `arm` — `ci-ledger-unreadable`, `eval-ledger-unreadable`,
`eval-stamp-mismatch`, `review-ledger-unreadable`, `review-missing`, `release-unauthorized`, `tip-unstamped`,
`commits-unstamped`, or `allow` — declared in `scripts/hooks/gate-decision.mjs` and
asserted by `pnpm guardrails`. A reason is written for one person reading one denial; an arm is written for a
query over a thousand. Counting denials without arms tells you a gate is expensive and never which control is
costing it.

## What one run of the eval suite leaves behind

- `evals/.results/<id>.json` — the full transcript of the most recent run of that case. Overwritten every
  run, and named in every failure line so a red case is one file away from its own evidence.
- `evals/history.jsonl` — one line per run: `{at, model, partial, passed, of, cost, cases[]}`. Committed,
  because it is the baseline a control band will read, and a baseline cannot be collected retroactively.

A `--only` run is recorded with `partial: true` rather than dropped, so a band can filter it out instead of
averaging one case into a suite-wide rate.

## What cannot be read from files

Three indicators are facts about a *session*, produced outside every process this repository controls:

- concurrent sessions per engineer,
- steering time against waiting time,
- tool decisions allowed and denied inside a session.

The agent emits these as OpenTelemetry or not at all. `pnpm telemetry` starts a dependency-free OTLP/HTTP
receiver that appends what it gets to `.git/everdict-telemetry.jsonl`; the environment recipe and the exact
signal names are in `scripts/telemetry/README.md`. Conversation content is deliberately excluded from that
recipe: this is a public repository, the sink writes to a plain file, and none of the three indicators needs
prompt or response text.

## The gaps, stated rather than implied

- **Telemetry is opt-in.** A session run without the recipe is invisible to the three indicators above, and
  that gap looks identical to a quiet week. Closing it means putting the variables in `.claude/settings.json`,
  which turns the export on for everyone and makes a session noisy when no sink is listening.
- **No baseline is old enough to band on.** `evals/history.jsonl` starts on 2026-09-05. A rolling baseline
  needs weeks, and the first control band is blocked on having one — which is the entire reason recording
  started before anything reads it.
- **The ledgers do not travel.** A second checkout starts with no history of what its gates decided. For one
  maintainer this costs nothing; it is the first thing to revisit if that changes.
- **The watcher exists and has nothing to band yet.** `pnpm watch-bands` reads these ledgers, computes rolling
  bands from `scripts/bands/bands.yaml`, and at 3σ files an `intent.md` into the queue with no person in the
  path — proven against a synthetic series at 3.32σ. Against the real ones it reports INSUFFICIENT, because
  the baseline started on 2026-09-05: 0/8 eval runs, 11/20 gate decisions, 1/6 reviews. That is the correct
  answer and the reason recording started before anything read it.

## Reading them

| Question | Command |
|---|---|
| has anything drifted? | `pnpm watch-bands` (`--dry-run` to see what it would file) |
| why is this gate red? | `pnpm triage <gate>` — runs it, reads its header, reports, never applies |
| what has the gate refused? | `.git/everdict-gate-log.jsonl`, grouped by `arm` |
| when did anyone last read this code? | `pnpm scan --status` — NEVER is an answer, and it is not "clean" |
