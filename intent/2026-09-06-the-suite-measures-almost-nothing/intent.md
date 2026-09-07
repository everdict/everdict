# Intent: the first complete drill-all says twelve of fifteen cases measure nothing

Author: maintainer (via AI-native SDLC audit, 2026-09-06). Status: shipped

Shipped: 31d380a9

Design: none — the design question ("what separates a case that measures from one that does not?") could not
be answered on paper. It was answered by running the experiment this intent asked for: rewrite each case
against the property the survivors share, then drill both states. The answer came from the drill, not from a
pass over the intent.

## Problem

The first `--drill-all` to finish without a rate limit ran all fifteen cases and came back **3 red, 12 green,
0 inconclusive**. Green means the case passes with its lesson removed — it certifies nothing.

    red    biome-write-is-not-evidence · provenance-at-the-source · skipped-scenario-is-not-passing
    green  completion-is-verified-zero · compute-handle-in-a-finally · docs-first ·
           dont-dodge-the-push-gate · empty-corpus-is-not-a-pass · english-only-source ·
           mutation-leak-staging · read-failure-is-a-third-value · route-nobody-opens ·
           settlement-owns-immutable-bytes · sibling-doors-guard-alike · untrusted-ingress-authorship

Four cases were retired earlier the same day for one cause — the answer was in the codebase — and that
finding was scoped to those four. It is not: it is most of the suite. The number the suite reports (15 cases,
20/20 green on a normal run) has been describing something other than what anyone believed it described,
since the day the suite was written. Every "the configuration still carries its lessons" claim this harness
has made rests on it.

**Retiring twelve is not the answer, and neither is keeping them.** Twelve retirements leave a three-case
suite; keeping them leaves twelve cases that produce a number nobody may act on. The cause has to be
separated first, because at least three different causes are consistent with a green drill and each has a
different repair:

- **(a) The codebase answers it.** Proven for the four retired: `QueueEntry`, `__EVERDICT_RESULT__`,
  `ci:local` are live symbols the case's own `Read,Grep,Glob` reaches. Repair: retire — the configuration was
  never what steered the answer.
- **(b) The lesson survives in another wording.** The exclusivity check matches EXACT strings, so a lesson
  restated in different words in a skill body, a doc or a case-law reference is invisible to it and to the
  drill. Repair: widen `subject`, then re-drill — the case may be sound.
- **(c) The model is good enough without the lesson.** `read-failure-is-a-third-value` and
  `completion-is-verified-zero` name protocol laws that are also ordinary engineering judgement; a capable
  model answers them cold. Repair: retire, or move the case to the part of the law a model does NOT get
  right by default — which is what the case-law references exist to record.

Guessing between the three is what produced the last wasted round: four assertions were narrowed on the (b)/
wide-assertion theory when the cause was (a), and narrowing moved in exactly the wrong direction.

## Proposed outcome

Each of the twelve carries a recorded CAUSE before it is touched, established by evidence rather than by
theory: for (a), the symbol the assertion matches is grepped in live source; for (b), the lesson is searched
for by meaning rather than by string, and any file carrying it is named; for (c), the case is run against a
tree with the lesson removed AND the codebase evidence removed, or it is accepted as general knowledge. Then
each is retired or repaired on its cause, and re-drilled to prove the verdict.

What comes out the other side is a smaller suite whose every case has a red drill on record — at which point
the stamp coupling deferred twice can finally land, and the number the suite reports means what it says.

## Affected users and systems

`evals/cases/*.json`, `evals/RETIRED.md`, `evals/README.md` (the case-selection principle), `evals/run.mjs`
(if the exclusivity check should look for meaning rather than exact strings), `evals/history.jsonl`, and the
stamp coupling in `intent/2026-09-06-what-the-second-audit-found/`.

## Constraints

- **No bulk action on a mixed population.** The twelve do not share a cause, and the last round proved that
  acting on the assumed cause wastes the budget and moves backwards.
- **Every verdict is drilled.** A case repaired without a red drill is the same unmeasured claim in a new
  spelling; a case retired without evidence of its cause loses coverage nobody can argue about later.
- **The suite may legitimately end up small.** Three honest cases beat fifteen that certify nothing, and the
  20–50 baseline is a target for cases that MEASURE, not a quota to backfill.
- Budget: at least one drill per case, plus a re-drill per repair. This is a change with a real cost and it
  should be planned as one rather than started in the last minutes of a session.

## Open questions

- Should the exclusivity check move from exact strings to something that can see a restatement? That is the
  (b) repair generalised, and it is hard — but a check that only catches copy-paste is why (b) was invisible.
- Is a case whose lesson a good model already knows worth keeping as a REGRESSION guard (it would catch a
  future weaker model), or is it noise? The suite's purpose says configuration; the article's model-swap
  question says the other thing.
- How much of the harness's "the configuration is regression-tested" claim has to be restated, in
  `docs/architecture/harness-declared-limits.md` and in the audit's own scoring, until this is fixed?

## Shipped, and the cause was a third one

Shipped in `31d380a9`. This intent named three candidate causes and said the twelve did not share one. That
was right, and the split was not the one it guessed.

**(a) the codebase answers it** — four cases, retired 2026-09-06.
**(c) the model is good enough without it** — SEVEN cases, and this is where the intent's caution paid.
Each was first REWRITTEN as a counter-intuitive yes/no where the intuitive answer is wrong, which is the
shape the survivors share. All eleven then passed in the normal state (so no assertion was too tight) and all
seven still passed drilled. A capable model declines to trust a 202, guards an empty corpus and refuses a
client-supplied scope without being told to.
**(b) a lesson restated in other words** — no case turned out to need it. The exclusivity check, widened to
every tracked text file, had already closed that route.

**And the instrument itself moved.** `provenance-at-the-source` drilled RED in one run and GREEN in the next,
untouched. Every retirement here therefore rests on TWO green drills rather than one, and the case that
flipped was kept. `lessons/2026-09-07-the-drill-is-not-deterministic.md` records it, and it re-reads this
intent's own opening claim: "12 of 15 measure nothing" was a single sample.

The suite is four cases, stated in `evals/README.md` as the measured size rather than the intended one.

## What this leaves open

The stamp coupling this intent hoped to unlock stays deferred, and now for a sharper reason than "the suite is
dirty": with a per-case verdict that can flip, a gate keyed to one drill would refuse pushes on a coin toss.
How many samples make a verdict is unsettled, and the honest options — more samples per drill, or a verdict
that reports the rate — both cost real agent calls per certification. Carried in
`lessons/2026-09-07-the-drill-is-not-deterministic.md`.

