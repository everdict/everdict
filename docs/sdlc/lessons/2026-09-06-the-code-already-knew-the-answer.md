# Three eval cases measured the codebase, not the configuration, and no assertion could have saved them

Date: 2026-09-06
Found by: the first `--drill-all` that could not lie, then by driving both halves of each drill instead of
just the failing one.

## What was believed

That a case going green under its removal drill meant one of two fixable things: the lesson had leaked into a
file the case did not name (the exclusivity check now refuses that), or the assertion was too wide and a
generic answer satisfied it. Both had just been observed and both were real, so the third possibility never
got asked.

Acting on that belief, three cases had their assertions narrowed to symbols only this repository could
name — `QueueEntry|runOne`, `__EVERDICT_RESULT__|job-runner`, `ci[:-]local|everdict-ci-ok` — on the reasoning
that a generic answer cannot produce a private symbol.

## What made it invisible

Narrowing an assertion and re-running only the drill looks like a repair whichever way it goes. A drill that
stays green reads as "not narrow enough", so the natural next move is to narrow further, and the loop has no
exit. What broke it was running the case in its NORMAL state as well:

    normal state   1/1 passed   — the assertion is not too tight
    removal drill  STILL GREEN  — and yet the lesson is not what produces the answer

Both halves together say something neither says alone: the answer is reachable without the lesson. And it
is — every one of those private symbols is live source the case's own `allowedTools: Read,Grep,Glob` can
reach. `QueueEntry` and `runOne` sit in `packages/backends` and `apps/api`; `__EVERDICT_RESULT__` in
`packages/contracts`; `ci:local` is a script in `package.json`. Asked what to watch when adding a
`DispatchOptions` field, an agent greps for it, finds the rebuild, and warns about it — with the rule deleted,
because that is what reading the code tells you.

The tighter the assertion, the more precisely it names the symbol the agent can grep. Narrowing was moving
in exactly the wrong direction, and the drill alone could not say so.

## What would have caught it earlier

Running both halves from the start — the case as it normally runs, and the case with its lesson removed —
and reading them as a pair. The single-direction drill answers "did it go red"; the pair answers "and was the
lesson the reason". That is the same shape skill `code-review` pass 5 already states for a refusal: a
predicate tested only on the class it rejects has an unmeasured false-positive rate. A drill tested only in
the neutralized direction has an unmeasured *cause*.

Cheaper still, and available before any agent call: ask whether the answer is in the tree. If a case's
expected artifact is a live symbol, the codebase can produce it and the configuration is not what is being
measured.

## What was done about it

Eval case: none — this is a rule about how cases are chosen, not a thing an agent gets wrong about the
configuration; replaying it as a prompt would test the wrong subject.

The three cases are retired with the reason (`evals/RETIRED.md`), taking the suite from 18 to 15, and the
principle they cost is now stated where the next case is written (`evals/README.md`):

> **A configuration eval can only measure what the codebase cannot answer.** If deleting the sentence still
> leaves a correct answer reachable by reading the repository, the sentence was not steering anything.

The cases that survive their drills all share the inverse property: their subject is a fact no file in the
tree states — an external tool's exit code lying about what it did, a norm about what counts as evidence, a
policy about language. Knowledge that exists only because somebody wrote it down after being burned.

## The question this leaves open

Eleven of the fifteen surviving cases have never been drilled honestly (a rate limit stopped the run). If the
same property holds for some of them, the suite is smaller than its count suggests and further from the
20–50 baseline than it looks. The next clean `--drill-all` is what answers it, and it should be read with
this lesson in hand: a green drill is not automatically a case to fix, it may be a case to retire.
