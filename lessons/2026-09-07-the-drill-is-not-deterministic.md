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
rewrite, rather than on one. `provenance-at-the-source` flipped and was therefore KEPT, and it stays in the
suite as the case that recorded this.

The honest reading of the earlier finding also changes. "12 of 15 measure nothing" was one sample; what two
samples support is narrower and still damning enough: **seven cases went green twice across a rewrite that
deliberately changed the question**, and those are gone. The suite is four cases now, and every remaining one
has at least one red drill on record.

## The question this leaves open

How many samples make a verdict? Two greens retired a case here, which is a judgement rather than a
calculation — with a per-case flip rate this high, two samples still admit a case that would have gone red on
the third. The honest fix is more samples per drill and a verdict that reports the RATE, not the last
answer; the honest objection is that each sample is a real agent call, and a suite that costs thirty calls to
certify is a suite that gets run once and then never again. That trade is not settled, and the stamp coupling
stays deferred until it is.
