---
kind: wiki
title: "Harness observability — what the harness can see about itself"
status: current
updated: 2026-09-07
---
# Harness observability — what the harness can see about itself

Everything this repository's gates know, they know about the **code**. This page is the inventory of what
they know about **themselves**, where each fact lives, and which questions still have no answer.

The distinction that organises it: a fact about a **tree** is answerable by reading files, and every check
under `scripts/` does exactly that. A fact about an **act** — a decision that was made, a session that ran —
exists only if something recorded it while it happened.

## The ledgers

They live in the COMMON git directory (`.git/` of the main checkout, shared by every linked worktree), and
that is deliberate: they describe *this repository's operations on this machine*, not the project's history.
None of them travels with a clone. The one exception is below the table, and it is an exception for a reason.

| File | Written by | Holds |
|---|---|---|
| `everdict-ci-ok` | `pnpm ci:local`, `pnpm ci:commits` | `<sha> full\|fast` per gated commit |
| `everdict-evals-ok` | `pnpm agent-evals` (full, clean-configuration runs) | the HEAD a green eval run attests |
| `everdict-review-ok` | `pnpm review` (full-range runs) | the HEAD a completed review attests |
| `everdict-review-<head>.json` | `pnpm review` | the findings, ranked, with the range and part count |
| `everdict-scan-log.jsonl` | `pnpm scan` | one line per scan: scope, head, model, file count, findings |
| `everdict-gate-log.jsonl` | `scripts/hooks/pre-push-gate.mjs`, on every push decision | `{at, verdict, arm, head, pushed, configChanged, productChanged, releaseTags, cwd?, reason}` — `cwd` only when the push came from a linked worktree |
| `everdict-telemetry.jsonl` | `scripts/telemetry/otlp-sink.mjs`, started by the SessionStart hook | one JSON line per OTLP payload a session exported |

Two records are COMMITTED rather than kept in `.git/`. `releases/<tag>.md` has to travel with the tag it
authorizes — an authorization that lives only in a working tree did not authorize anything anyone else can
see. `findings/DISPOSITIONS.md` grades what the reviewer and the scanner reported, and travels for the sibling
reason: the reports are this checkout's operations, but the judgement on them is the project's.

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
- `evals/history.jsonl` — one line per run: `{at, model, models[], partial, passed, of, executed, cost, cases[]}`.
  Committed, because it is the baseline a control band will read, and a baseline cannot be collected
  retroactively. `models[]` is the model IDs that actually answered, read from each envelope: `model` is the
  alias the suite asked for, and an alias moves without a commit here to trigger on.
- Also in `evals/history.jsonl`, one line per **drill**: `{at, model, drill: <id>, red, seconds, subjects}` —
  whether the case went red without its lesson, and a digest of the subject files it certified. An errored or
  timed-out agent call is inconclusive and records nothing, so a rate-limited `--drill-all` fails rather than
  writing false reds. `pnpm agent-evals --drill-status` reads those lines and reports never / green / drifted /
  red per case. The stamp is not yet coupled to this (it needs a clean drill-all to land with it — see
  `evals/README.md`); today the state is advisory.

A `--only` run is recorded with `partial: true` rather than dropped, so a band can filter it out instead of
averaging one case into a suite-wide rate.

## What cannot be read from files

Three indicators are facts about a *session*, produced outside every process this repository controls:

- concurrent sessions per engineer,
- steering time against waiting time,
- tool decisions allowed and denied inside a session.

The agent emits these as OpenTelemetry or not at all. A `SessionStart` hook starts a dependency-free OTLP/HTTP
receiver that appends what it gets to `.git/everdict-telemetry.jsonl`; the environment recipe and the exact
signal names are in `scripts/telemetry/README.md`.

**And `pnpm telemetry-report` reads it back**, which is the half that was missing for a day: the sink filled
with over a thousand payloads and nothing queried them. A measurement nobody can produce is not instrumented —
the article's test is that someone who did not build the harness gets the number in one command. The reader
answers all three indicators (peak concurrent sessions, active seconds against the sessions' own wall clock,
tool decisions by verdict and source), refuses an empty ledger the way every check here does, and prints no
identity: the payloads carry an email, a user id and an organization id, and none of the three needs them.

Conversation content is deliberately excluded from the export recipe: this is a public repository, the sink
writes to a plain file, and none of the three indicators needs prompt or response text.

⚠️ **Zero tool denials in that stream is not "nothing is guarded".** The exporter reports the tool layer, where
this repository's allow list pre-approves the inner loop; the refusals that matter are the push gate's, and
they are in `.git/everdict-gate-log.jsonl` grouped by arm. The report says so at the point it would otherwise
mislead.

## The concurrency ceiling

The article ties the number of parallel sessions to review capacity rather than to taste: *"add sessions only
while review is keeping up."* Here that number is **three**, and the arithmetic is short.

Every push carrying `packages/**` or `apps/**` costs one `pnpm review` — one to five chunked sessions, one to
three minutes each — and the findings are triaged by one person. Three streams produce roughly one review
queue that a person clears in the same sitting. A fourth does not fail; it produces findings faster than they
are read, and unread findings are the state `REVIEW.md`'s nit cap already exists to prevent.

It is a stated ceiling, not an enforced one — nothing counts sessions and refuses a fourth, and nothing
should: the number is a judgement about attention, and the right response to exceeding it is to notice, not to
be stopped. What makes it checkable is `claude_code.session.count` in `.git/everdict-telemetry.jsonl`, which
carries a session id, so "how many ran at once last week" is a query rather than an impression. Revise the
number when that query and the rework rate disagree with it.

## The gaps, stated rather than implied

- **The collector starts with the session, and nothing bounds its lifecycle.** A `SessionStart` hook
  (`scripts/telemetry/ensure-sink.mjs`) probes the OTLP port and spawns the sink detached when nothing answers,
  so the gap that used to be "somebody forgot the second terminal" is closed — the audit had read the ledger
  and found two probe lines from the day the sink was written. What replaces it is accepted rather than
  bounded: one sink per machine, bound to the port, refused when the port is busy, dying with the machine,
  reaped by nobody. Sessions in linked worktrees export to the same port, so the ledger in the common git
  directory holds every checkout's sessions together.
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

## What happened to what the reviewer found

Every control here can show what it refused except one. The push gate logs an arm per denial, the scan records
a dismissal with its reason, the eval suite proves a case measures its lesson by removing it — and the
reviewer produced findings that nobody ever graded. The article names the counter-metric for that play
outright: **finding precision**, tuned by rating findings.

`findings/DISPOSITIONS.md` is that rating, and it is COMMITTED for the reason `scans/DISMISSED.md` is: the
reports are this checkout's operations and live in `.git/`, but the judgement on them is the project's, and a
judgement nobody else can read is one the next person makes again. One line per graded finding, written by
`pnpm findings --record`, with a verdict of `real`, `false-positive`, or `carried` (real, deliberately not
fixed here, an intent holds it) and a reason at least twelve characters long.

`pnpm findings` reports precision over what has been graded and lists what has not. Two properties matter:
carrying a finding counts toward precision because carrying is not disagreeing, and an ungraded corpus reports
**UNKNOWN** rather than 100% — the absence of the measurement is not a perfect score.

## Reading them

| Question | Command |
|---|---|
| has anything drifted? | `pnpm watch-bands` (`--dry-run` to see what it would file) |
| why is this gate red? | `pnpm triage <gate>` — runs it, reads its header, reports, never applies |
| what has the gate refused? | `.git/everdict-gate-log.jsonl`, grouped by `arm` |
| when did anyone last read this code? | `pnpm scan --status` — NEVER is an answer, and it is not "clean" |
| how many sessions ran at once, and how much was steering? | `pnpm telemetry-report` (`--json` for a band) |
| was what the reviewer found worth reading? | `pnpm findings` — precision over graded findings, and what is ungraded |
