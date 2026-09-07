# `evals/` — regression tests for the configuration that steers the agent

`pnpm docs-check` and `pnpm convention-harness` ask whether `CLAUDE.md`, the rules and the skills are still
SHAPED right: paths resolve, symbols exist, globs match live code, descriptions survive. Neither can ask the
question that matters after a skill is edited — **does the agent still do the work to the same standard?**

A skill edit that stops it triggering, a rule whose wording drifted from what it meant, a `CLAUDE.md` line
deleted as redundant: every one of those leaves every existing gate green, and the only witness is the next
session that quietly does the wrong thing. `evals/` is that witness, written down.

## Running it

```sh
pnpm agent-evals                      # the whole suite (pinned model)
pnpm agent-evals --only <id>          # one case
pnpm agent-evals --list               # ids and their subjects
pnpm agent-evals --model opus         # the other question: does a model swap still pass?
pnpm agent-evals --drill <id>         # the removal drill — see below
```

Each case is one `claude -p` run with `cwd` at the repository root, which is the point: `CLAUDE.md`, the
rules and the skills are discovered exactly as a real session discovers them. Transcripts land in
`evals/.results/<id>.json` (gitignored) and are named in every failure line.

**The model is held to one alias by default** (`sonnet`), and that is a deliberate trade. Holding it makes
the *configuration* the only variable a run changes on purpose — it is not a pin: an alias moves when the
provider moves it, with no commit here to trigger on, so every result and every history line records the
model IDs that actually answered (`models`, read from the envelope), and a moved alias is visible in the
ledger rather than assumed away by the word "pinned". It keeps a run affordable — the ambient default here is opus-1M, where a trivial call costs
$0.22, and a suite that costs that per case is a suite that gets switched off. `--model <alias>` asks the
article's other question: when a new model is swapped in, does the agent still do the work?

## A case

```json
{
  "id": "biome-write-is-not-evidence",
  "why": "the incident this comes from, in one line",
  "subject": [".claude/rules/ci.md"],
  "neutralize": ["biome check --write", "unsafe"],
  "allowedTools": "Read,Grep,Glob",
  "prompt": "what a person would actually say",
  "expect": { "mustMatch": ["pnpm lint", "unsafe"], "mustNotMatch": [] }
}
```

**The suite is four cases, and that is the measured size rather than the intended one.** Two complete
drill-alls in one session retired eleven: four because the answer sat in live source, seven because a capable
model answers them cold — including after each was rewritten as a counter-intuitive yes/no where the intuitive
answer is wrong. What survives shares one property: the correct answer names something **this repository
invented and a model cannot derive** — an external tool's counter-intuitive exit behaviour, a private gate's
name, a private environment variable. The article's 20–50 baseline is a target for cases that MEASURE, and
backfilling toward the number with cases that do not is how the suite got here. See `RETIRED.md`, and
`lessons/2026-09-07-the-drill-is-not-deterministic.md` for why a retirement now needs two green drills.

**Before any of the fields: can the CODEBASE answer this?** A configuration eval can only measure what the
repository cannot state for itself. Every case grants `Read,Grep,Glob`, so if deleting the sentence still
leaves a correct answer reachable by reading live source, the sentence was not steering anything and the case
measures the codebase. Three cases were retired on 2026-09-06 for exactly this — their assertions had been
narrowed to private symbols (`QueueEntry`, `__EVERDICT_RESULT__`, `ci:local`) on the theory that a generic
answer could not produce them, which is true and beside the point: those symbols are live source an agent
greps. Narrowing moved in the wrong direction, and only running the case in BOTH states showed it (normal:
passes, so the assertion is not too tight; drilled: still passes, so the lesson is not the cause). The cases
that survive are the ones whose subject is a fact no file in the tree states — a tool's exit code lying about
what it did, a norm about what counts as evidence, a policy about language. See
`lessons/2026-09-06-the-code-already-knew-the-answer.md`.

- **`why`** names the incident. Cases come from failures that actually happened here and are already written
  down. An invented case tests an invented convention.
- **`subject`** is every file that carries the lesson — often more than one, because the good ones are
  recorded in a rule *and* a skill *and* `CLAUDE.md`.
- **`neutralize`** are the sentences the drill removes. Every one of them must appear in some subject: the
  suite refuses to load a case whose neutralization matches nothing, because a declaration whose target was
  reworded still reads as a claim about what the case measures.
- **`expect`** asserts on ARTIFACTS the agent must name — a command, a file it must read first, a refusal —
  never on phrasing. The first version of `ci-local-before-push` asserted the literal `ci:local` and went red
  against an answer that had *run the gate* and written "CI-local"; the behaviour was right and the assertion
  was wrong. Assertions are regexes, matched case-insensitively.

## The removal drill

```sh
pnpm agent-evals --drill ci-local-before-push
```

Deletes every line in the case's subjects containing one of its `neutralize` strings, re-runs that case, and
**requires it to go RED**, restoring the files in a `finally`. It removes the sentence, not the file: blanking
a whole `CLAUDE.md` proves only that an empty `CLAUDE.md` steers nothing.

This is the part that makes the rest worth anything. Without it the suite proves that seven agent calls
returned text. `scripts/trust/protocol-mutations.mjs` is the same idea one layer down, over the product's
protocols — and where that gate costs ninety minutes of real builds and real suites, this one costs a single
agent call, which is why it can stay.

**A drill result is a ledger line, and a drill has an expiry.** Every drill appends
`{drill: <id>, red, seconds, subjects}` to `evals/history.jsonl` — `subjects` is a digest of the subject files
it certified. `--drill-status` reports each case as never / green / drifted (red, but a subject changed since)
/ red; `--drill-all` re-runs every drill and fails if any stays **green** (a case that does not measure its
lesson) or comes back **inconclusive** (the agent never answered — a rate limit, not a red; the two are kept
apart so a throttled run cannot manufacture a certificate). Until 2026-09-06 a drill was run once, when its
case was written, and its verdict lived in a terminal that closed; one went stale the next day.

The stamp is **not** yet coupled to the drill state, and that is deliberate. The honest gate refuses the stamp
until every case holds a red drill, but that gate needs one clean `--drill-all` to land alongside it — and
this repository forbids a gate that ships before its fix. A clean drill-all is twenty real agent calls a rate
limit can throttle, and it also surfaces the handful of cases that stay green on their own (their assertions
are generically answerable). Until those are re-pointed or retired and a green drill-all exists, the drill
state is advisory: `--drill-status` reports it and the person reads it. Tracked in
`intent/2026-09-06-what-the-second-audit-found/`.

**And the lesson may not live anywhere the case does not name.** At load, every case's `neutralize` set is
looked for in every tracked markdown file outside its `subject`; a file that carries all of them is refused
with the repair named — add it to `subject` (the drill then removes the lesson there too) or reword it. The
session under test can Grep the whole tree, so a copy of the lesson in a `lessons/` entry or in this README
answers the prompt after the drill has removed it from the subjects, and the drill certifies nothing. The
first run of that check refused eleven of twenty cases. The fingerprint is the whole set, so one shared word
is not a leak. There is no allowlist: a file a session can read after the removal makes the drill vacuous
whether or not somebody signed for it.

A killed drill leaves nothing behind. The neutralization happens inside the throwaway worktree, so the
repository is never edited and there is nothing to restore — which is why the `.git/everdict-eval-drill-stale`
marker this section used to describe was removed along with the in-tree neutralization it protected. The
description outlived the mechanism by a week, which is the ordinary way a document becomes a promise nobody
keeps.

## Where it is enforced — the push gate, not CI

Not in `pnpm ci:local`, for the reason `protocol-mutations` left CI: a gate that makes every iteration wait
gets switched off, and then nothing runs. Not in GitHub Actions either, and that one is worth stating plainly
— **the suite never needed an API key.** Five local runs used the machine's existing login, which is the same
principle this repository already states for the execution layer: *"for LocalDriver the harness uses the
machine's existing login (no API key)."* A GitHub runner is a bare machine with no login, so running it there
would require an `ANTHROPIC_API_KEY` secret — a cost of the delivery choice, not of the thing delivered.

So it is enforced where enforcement already lives. `scripts/hooks/pre-push-gate.mjs` denies a push whose
commits are not in the CI-parity ledger; it now also denies a push that **changes** `CLAUDE.md`, `.claude/**`
or `evals/**` unless `.git/everdict-evals-ok` stamps the current HEAD. A green `pnpm agent-evals` writes that
stamp. A push that leaves the configuration alone never meets the arm.

The stamp attests a COMMIT, so a run over dirty configuration declines to write one and says so: the suite
overlays the working tree's `CLAUDE.md`/`.claude` into its worktree precisely so an edit can be tested before
it is committed, and that is the same reason such a run cannot then vouch for HEAD. `--only` never stamps —
it answers about one case, and the gate asks about the configuration.

Unlike the CI ledger, the eval stamp is **tip-only**. That one is per-commit because a bisect lands on an
intermediate commit; nobody bisects a skill's wording.

## The history

Every run appends one line to `evals/history.jsonl` — timestamp, model, per-case outcome, cost. `.results/`
is overwritten each run, so before this the eval pass rate had no history at all, and that closes a door: a
control band needs a rolling baseline, and a baseline cannot be collected retroactively. Every unrecorded run
was a run that could never be part of one.

A `--only` run is recorded with `partial: true` rather than dropped, so a band can filter it out instead of
averaging one case into a suite-wide rate. The file is excluded from the stamp's cleanliness check and from
the push gate's configuration set (`CONFIG_PATHSPEC`, one definition read by both): it is what a run WRITES,
and treating it as configuration closes a loop with no exit — appending dirties `evals/`, a dirty `evals/`
refuses the stamp, and earning the stamp appends again.

## Owed: the model-swap question — half paid

*"When a new model is swapped in, does the agent still do the work to the same standard?"* — the article's
other question, and the reason a scheduled run exists at all, since a model change moves the answer with no
commit to trigger on. **There is no unattended answer to it here**, because that needs CI credentials and this
repository chose not to hold them. `pnpm agent-evals --model <alias>` asks it by hand. Half of the debt is
paid without a schedule: the model that actually answered is in every history line, so the day the alias
moves under the suite is a query, not a guess. Removing this section is the definition of done for the rest.

## Growing the suite

The article's baseline is 20–50 real tasks. This one went 1 → 6 → 13, and every case after the first six came
from a ⚠️ block in `.claude/rules/ci.md` — that file is a list of incidents with their repairs, which is
exactly the raw material a case is made of. Writing eight took one pass; two were refused at load because
their `neutralize` strings did not match a live line, which is the check doing its job before a run was paid
for; one was retired after the run (`RETIRED.md`).

The pattern that keeps working: take an incident, ask what a person would actually say at the moment it
happened, and assert on the artifact a correct answer must name. The pattern that keeps failing is asserting
on a word — three cases have now gone red against correct answers for that reason, the last one against an
answer that named `--no-verify` only to say it does not help.

## What the runs cost, and what they bought

Calibration is not overhead; it is the work. Every one of these was found by running the suite, not by reading
it — and four of the six were defects in the suite itself, which is the ordinary case.

| Run | Result | What it found |
|---|---|---|
| 1 | 0/1 | The assertion required the literal `ci:local` and went red against an answer that had **run the gate** and written "CI-local". The behaviour was right; the assertion was a word. |
| 2 | 4/7 | The eval sessions **wrote to the repository under test** — `packages/graders/src/step-budget.ts` created, two files edited. `--allowedTools` ADDS to what is permitted, and the session inherited `.claude/settings.json`. Hence the throwaway worktree, the deny list, and the after-check that observes the deny actually refusing. |
| 3 | 5/7 | Two lessons lived only in `.claude/rules/ci.md`, which is injected while you EDIT — so a question asked before touching anything never reaches them. The unsafe-fix trap and the `trust-fast` skip rule moved into `CLAUDE.md`. |
| 4 | 6/7 | `authz-optional-reflex` tested a call this repository cannot make (see `RETIRED.md`). |
| 5 | **7/7** | A prompt a correct **generic** answer satisfies cannot test a **specific** lesson: "is lint green?" is answerable with "run `pnpm lint`" by anyone. Narrowed to "`--write` exited 0 but `pnpm lint` still fails — how?", where the lesson is necessary. |

Then the drills, which found three more — a `process.exit()` inside a `try` that skipped its `finally` and
leaked a worktree per run; a load-time check matching whole files where the drill matches lines; and a line
satisfying two `neutralize` needles that credited only the first. One case was retired rather than tuned.

A full run is about 90 seconds of wall clock and **roughly $1.50–1.70** at the pinned model. That number is
why the path filter exists.
