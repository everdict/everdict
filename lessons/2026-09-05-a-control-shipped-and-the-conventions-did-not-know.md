# A control shipped, and the conventions did not know

Date: 2026-09-05
Found by: reading the commit's own diffstat, one commit too late

## What was believed

That the round which had just fixed this class had fixed it. `intent/2026-09-05-the-conventions-do-not-know-the-harness/`
was filed, shipped and closed twenty minutes earlier: six controls existed and `.claude/` stopped before them,
so five skills, CLAUDE.md and the docs index were pointed at them. The belief was that naming the problem and
repairing every instance was the end of it.

It was not. The very next control — `pnpm scan` — shipped with `.claude/rules/ci.md`, `CLAUDE.md` and
`docs/README.md` untouched, by the same author, in the same session.

## What made it invisible

Two things, and only the second is interesting.

The proximate cause was an edit script that asserted `'pnpm scan' not in s` before writing. `.claude/rules/ci.md`
already contained "pnpm scanner-watches", which contains that substring. The assertion fired, the script exited
before writing anything, and the code commit went out alone. The assertion was doing its job — it was written to
prevent a double-insert — and its failure mode was silence in the half nobody was watching.

The structural cause is that **no gate asks whether a control is documented**. `pnpm convention-harness` asks
whether a rule still reaches live paths. `pnpm docs-check` asks whether the paths and symbols a rule NAMES
exist. Neither asks the reverse question: does every control that exists get named by anything? The previous
round repaired every instance of that gap by hand and shipped no way to notice the next one — which is the
exact criticism that round made of prose laws.

## What would have caught it earlier

The cheapest thing: a check that walks `package.json`'s scripts, keeps the ones that point into `scripts/` or
`evals/`, and requires each to be mentioned in `.claude/rules/ci.md`. Ten lines, no model, no judgement. It
would have failed on the commit that shipped the scan.

Not: a review pass, which would also have worked and costs a session; not: remembering, which is what the
previous round relied on.

## What was done about it

`pnpm controls-documented`, wired into `ci.yml` and `ci:local`. A control that exists and is named nowhere is
now a red gate rather than a thing somebody notices while reading a diffstat.

The general shape is worth keeping in view: a round that repairs every instance of a class, and ships no way to
detect the next instance, has bought one repair at the price of believing it bought a rule.
