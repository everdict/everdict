# I read a pipe's tail as a check's verdict, twice in one session

Date: 2026-09-06
Found by: the commit gate, both times — after the commit was already made.

## What was believed

That `npx biome check <files> 2>&1 | tail -2` showing nothing alarming meant the files were clean.

A pipeline's exit status is the LAST command's. `tail` always succeeds. So the status that mattered was
discarded at the `|`, and what remained was two lines of whitespace — which is what a clean run also looks
like. Both times the check had failed on `lint/style/useTemplate`, and both times the commit was already
made when `pnpm ci:local` said so.

## What made it invisible

`.claude/rules/ci.md` already carries the sibling warning, in capitals: **`biome check --write` does not
apply Biome's "unsafe" fixes, and exits 0 anyway** — so a file comes back from the formatter reporting
success and still fails `pnpm lint`. That rule was read and obeyed: the formatter was run, and then the
check was run after it, exactly as the rule says.

The rule says to run the check. It does not say how to READ it, because for a person at a terminal there is
nothing to say — they see red text. An agent pipes the output somewhere and looks at what comes back, and
the one thing a pipe reliably destroys is the answer.

The second occurrence is the one that matters: the exit code was printed that time (`lint exit=1`) and the
commit ran anyway, in the same `&&`-free command chain. Printing a status is not checking it.

## What would have caught it earlier

`set -o pipefail`, or simply not piping: run the check, read `$?`, and branch on it. A check whose result is
consumed by a human eye and a check whose result is consumed by a program are not the same check, and only
the second one has an exit code that anybody has to respect.

The cheap habit: **never put a gate inside a command that also commits.** The two belong in separate calls
with the status read between them.

## What was done about it

Eval case: none — `pnpm ci:local` already catches it, and a check about how an agent reads its own shell output belongs in the agent's configuration.

Nothing mechanised, and the reason is that the failure is not in this repository. `pnpm ci:local` already
catches it — it caught it both times, which is the gate working — and `pnpm ci:commits` catches it per
commit before a push. A repository-side check that watches how an agent reads its own shell output would be
a check about the agent, and the agent's own configuration (`CLAUDE.md`, the rules, the skills) is where
that belongs.

What is recorded instead is this page, and the sentence it exists for: in this repository, a check's verdict
is its EXIT CODE. Its output is for a person.

## The question this leaves open

`.claude/rules/ci.md` warns about a tool that exits 0 while having failed. This is the mirror — a tool that
exits non-zero into something that does not care. Whether that belongs in the rule, or is one of the things
a rule cannot usefully say, is a judgement somebody should make rather than inherit.
