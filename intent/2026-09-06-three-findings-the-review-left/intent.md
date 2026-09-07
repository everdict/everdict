# Intent: three Important findings the review left standing, and why they were not fixed in the same breath

Author: maintainer (via `pnpm review` on 2ebc79ca). Status: shipped

Shipped: 06698280

Design: none — three independent repairs, each with its counterexample named in this intent already. A design
pass would restate them.

## Problem

`pnpm review` over `origin/main...HEAD` (158 files, 3 parts) returned five Important findings. Two were fixed
in the commit that follows it, because both were about a certificate lying: the eval stamp counted only
`failed` and would have attested a run whose agent never answered some cases, and `check-swallowed-reads`'s
header claimed a baseline of 83 against a file summing to 105. The other three are real and are NOT fixed
here, each for a reason that would otherwise go unrecorded.

- **`scripts/check-swallowed-reads.mjs` scans `.ts` and never `.tsx`.** A swallowed read introduced in any
  `apps/web` or `apps/desktop` component is invisible to the ratchet — the gate reports PASS over a region it
  does not read, which is the empty-corpus failure this repository names in `CLAUDE.md` in its own words.
  Not fixed in place because widening the glob will surface existing `.tsx` occurrences, and a ratchet whose
  baseline jumps in the same commit that widens it cannot be told from one that was quietly re-based. The
  widening and the newly-counted baseline belong in a change that shows both numbers.
- **`scripts/bands/watch.mjs`'s hand-rolled YAML parser mis-types a field silently.** It coerces only
  `/^\d+$/` to a number, so a threshold that gains whitespace, a comment or a decimal point becomes a string,
  and a string compared against a sigma is a band that never fires. The config is versioned precisely so an
  alarm is reproducible, and the reader in front of it can fail open on a formatting edit. Not fixed here
  because the honest repair is a validating parse that REFUSES an unreadable band rather than a tighter
  regex, and that is a change with its own counterexample to write.
- **The `evals/history.jsonl` exclusion pathspec is duplicated** between `scripts/ci-commits.mjs` and
  `scripts/ci-local.mjs` (and arguably a third place) rather than exported once. `gate-decision.mjs` already
  exports `CONFIG_PATHSPEC` for exactly this reason and these two do not use it. The bug it invites is the
  one this repository has already paid for: the loop where appending to the history dirties the tree, a dirty
  tree refuses the stamp, and earning the stamp appends again — closed in one file and re-opened in its
  sibling, which is what `pnpm guard-siblings` exists for.

## Proposed outcome

Each is closed with the counterexample its class demands: a `.tsx` file carrying a swallowed read is REFUSED
by the ratchet (and the baseline states both numbers, before and after); a `bands.yaml` whose threshold is
unparseable makes `watch-bands` refuse rather than pass; and the exclusion pathspec has one definition that
both scripts import, proven by deleting it in one place and watching both fail.

## Affected users and systems

`scripts/check-swallowed-reads.mjs` + `scripts/swallowed-reads-baseline.txt`, `scripts/bands/watch.mjs`,
`scripts/ci-commits.mjs` + `scripts/ci-local.mjs` + `scripts/hooks/gate-decision.mjs`.

## Constraints

- **A widened ratchet shows both numbers.** 105 across 61 files today; whatever `.tsx` adds is stated
  separately, or the widening reads as a re-base.
- **The band parser must refuse, not guess.** "Cannot find out" is an escalation (rule `protocol` L2), and a
  band config that cannot be read is exactly that.
- No new bypass, and each fix carries the counterexample seen RED first.

## Open questions

- Is a hand-rolled YAML reader still the right trade? It was chosen to avoid a dependency for one shape. A
  validating parse of that one shape is more code than the current reader; a dependency is a different cost
  this repository has consistently declined.
- Does `guard-siblings` already have the vocabulary to catch the duplicated pathspec, and if so why did it
  not? That question is worth more than the fix.

## Shipped

All three, in `06698280`, each with the counterexample this intent asked for.

- **`.tsx`** — widened, and the widening cost 27 occurrences across 17 files, all pre-existing. The header
  records both baseline moves separately (83 → 105 a correction, 105 → 132 a widening) so the growth cannot
  be read as a quiet re-base, which was this intent's stated constraint. A fresh `.catch(() => [])` in a
  `.tsx` file is refused; removing it turns the gate green.
- **The band parser** — the repair is a validating check rather than a wider regex, as required. Three
  counterexamples drove it: a decimal `window`, a quoted `floor`, and `direction: sideways`. Each refuses with
  its own reason and exits 1; the real config exits 0. The discovery along the way: `slice(-"20.5")` is
  `slice(NaN)`, which returns the whole array — a mis-typed window did not fail, it silently widened the band
  to every sample ever recorded.
- **The duplicated pathspec** — `RUN_OUTPUT_EXCLUDE` is exported and imported; the literal survives in one
  place. The finding under it was worse than duplication: the comment above the constant claimed the
  exclusion came "from this one definition, so the two cannot drift", while four copies sat elsewhere. A
  comment promising another component's behaviour, in the file that states that law.

## The open question this answered

*Does `guard-siblings` already have the vocabulary to catch the duplicated pathspec, and if so why did it
not?* It does not, and the reason is worth keeping: `guard-siblings` compares DOORS within one resource — the
routes of an API slice — for guards their siblings carry. A constant copied between two gate scripts is not
that shape. What would have caught it is what did: a reviewer reading for what a change now rests on. The
gap is real and unfilled, and naming it here is cheaper than a scanner that would fire on every legitimate
shared string.

