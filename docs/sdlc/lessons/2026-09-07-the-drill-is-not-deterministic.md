# The same drill went red in one run and green in the next, with its case untouched

Date: 2026-09-07
Found by: running `--drill-all` twice in one session, the second time to check a batch of rewrites, and
comparing the two outputs line by line.

## What was believed

That a drill's verdict is a property of the case. Red means the case measures its lesson; green means it does
not; run it again and you get the same answer. Every decision built on the drill assumed this — the
certificates on `harness-drill-certificates.md`, the retirements in `RETIRED.md`, the deferred stamp
coupling, and the audit finding that "12 of 15 cases measure nothing" — all of them read a single run as a
fact about the suite.

## What made it invisible

The first complete drill-all was the first time the mechanism had ever run clean, and it produced a
strikingly coherent story: three red, twelve green, and the greens shared an obvious cause. A result that
explains itself that well does not invite a second run.

Then a second drill-all, over a batch of rewrites, reported `provenance-at-the-source` as GREEN. That case
had drilled RED an hour earlier and **nothing about it had changed** — not its prompt, not its assertion, not
its subjects. The only thing that changed was the run.

The mechanism is honest about everything except this. It separates red from green from inconclusive, it
refuses to record an errored call, it carries a digest of the subjects it certified — and then reports one
sample as a verdict. The `--drill-status` vocabulary has no word for "asked twice, answered differently".

## What would have caught it earlier

Running any drill twice, once. The cost is one agent call and it falsifies the assumption immediately.

More precisely: treating the drill as what it is — **a stochastic measurement of a stochastic system.** The
thing under test is an agent's answer to a prompt, and that answer is not fixed. A single red proves the case
CAN discriminate; it does not prove it always will. A single green proves the case did not discriminate that
time; it does not prove it never will.

## What was done about it

Eval case: none — this is a property of the measuring instrument, not of the configuration the instrument
measures. Replaying it as a prompt would test the wrong subject.

The seven cases retired in this session were retired on **two green drills each**, before and after a
rewrite, rather than on one. `provenance-at-the-source` flipped and was therefore KEPT.

⚠️ **It was retired later the same day, and NOT for flipping.** Reading the case rather than its verdict found
two defects the drill could not have told apart from noise: its assertion (`provenance|re-derive|at the
source|carried|source`) is satisfied by any competent answer to its own question, and its `neutralize` named
only the L3 HEADING while the sentence that answers the prompt — *"Banned re-derivations: metric name → judge
id"* — stayed in the file. So the drill removed a title and left the lesson, and neither of its two verdicts
meant what it said. The flip was the symptom that made somebody look; the reason is in `evals/RETIRED.md`.

That sharpens the question below rather than answering it. More samples would have told us the case was
unstable; only reading it told us why.

The honest reading of the earlier finding also changes. "12 of 15 measure nothing" was one sample; what two
samples support is narrower and still damning enough: **seven cases went green twice across a rewrite that
deliberately changed the question**, and those are gone. With the eighth retired for the reasons above the
suite is three cases, and every remaining one has at least one red drill on record.

## ⚠️ Part of it was not noise, and the mechanism was found the same day

The throwaway worktree is `git worktree add --detach HEAD`, so it carried every tracked file — including
`evals/cases/*.json`, each of which names its own `mustMatch` string and its own `neutralize` needles. Every
case grants `Read,Grep,Glob`. So a session asked one of these questions could grep a word from the question,
land on the case file that asks it, and read the assertion it was about to be graded against: the exam paper,
in the room, in a file the drill does not touch because it is not a `subject`.

The exclusivity check exempts `evals/cases/` from its leak scan and is right to — a case naming its own needles
is not a copy of the lesson. That exemption was silently doing a SECOND job nobody argued for. The worktree
drops the directory now.

⚠️ **It did not explain the flips.** A leak can only push a drill toward GREEN, and the observed sequences —
`provenance-at-the-source` RED then GREEN, `biome-write-is-not-evidence` RED RED then GREEN GREEN after the
leak was closed — have reds the leak cannot account for and greens that survived closing it. Both cases were
retired on what reading them showed instead: an assertion satisfied by any competent answer, and an assertion
naming a distinction the TOOL documents rather than this repository. The flip was the symptom that made
somebody look at each of them; neither retirement rests on it.

The honest summary is narrower than "the drill is not deterministic" and more useful: **a drill's verdict
varies when the case sits where the lesson and a capable model's default answer agree**, and the way to find
that is to read the assertion and ask who owns the word it demands.

By the end of the same evening three cases had been read that way and all three died of one thing — an
assertion alternative reachable from the tree the drill leaves standing (`source`, a live `package.json`
script name, five files called `*-baseline.txt`) or from what a model already knows (a distinction the TOOL's
own documentation makes). That is a defect in how cases are WRITTEN, not in how they are drilled, and it is
mechanisable at load time: `intent/2026-09-07-assertions-reachable-without-the-lesson/`.

## The question this leaves open

How many samples make a verdict? Two greens retired a case here, which is a judgement rather than a
calculation — with a per-case flip rate this high, two samples still admit a case that would have gone red on
the third. The honest fix is more samples per drill and a verdict that reports the RATE, not the last
answer; the honest objection is that each sample is a real agent call, and a suite that costs thirty calls to
certify is a suite that gets run once and then never again. That trade is not settled, and the stamp coupling
stays deferred until it is.
