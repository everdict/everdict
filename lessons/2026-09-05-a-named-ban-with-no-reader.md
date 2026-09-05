# The rule banned the spelling by name, and nothing in the repository read for it

Date: 2026-09-05
Found by: a review of the seven commits on `main` this branch was behind — so, by a person, one commit after
it shipped, and only because somebody happened to review a range they were about to merge.

## What was believed

That `.claude/rules/protocol.md` L2 was enforced. It is the law with the most case law behind it in this
tree, it names the forbidden spellings *in so many words* — `.catch(() => [])`, `.catch(() => undefined)`,
`.catch(() => ({}))` — and it is injected into context by a `paths:` glob while you edit. A law that
specific, arriving at the moment of editing, feels enforced.

It was prose. `grep -l "catch(() =>" scripts/check-*.mjs` returned nothing. Twenty-nine gates, and the one
with the longest incident list behind it had no reader.

## What made it invisible

Three things, and the third is the one worth keeping.

1. **The rule reads like a gate.** It is written in the imperative, it lists its escape hatches by name, and
   it sits in a directory whose whole purpose is enforcement. Nothing in it says "and nobody checks this".
2. **`convention-harness` and `docs-check` both pass over it.** One asks whether a rule reaches live paths;
   the other asks whether the paths and symbols it names exist. Both were green. Neither asks whether
   anything ACTS on what the rule says — that arrow is not run by any gate, and `controls-documented` runs
   the other one (does every control get named?), which is not the same question.
3. **The defect arrived inside the fix for the same law.** `f7eaccda` is titled *"two pointers with no
   reader"* and its whole subject is a value that existed and was consumed by nobody. It gave
   `inheritedFindings` a `.catch(() => undefined)` on a store read, forty lines below an
   `evidenceUnavailable` the same method already computes correctly for the same brief. The author knew the
   law well enough to implement its remedy in one place and spell its violation in the other, in one commit.

That third one is why "be more careful" is not the repair. The person was being careful; care is what
produced the correct half.

## What would have caught it earlier

A grep. Not a review, not a scan, not a model — a regular expression over the tree, which is what the rule
already is. The whole gate is forty lines and runs in two seconds, and the reason it did not exist is that
the law was written down so well that writing it down felt like finishing.

## What was done about it

A check: `pnpm swallowed-reads` (`scripts/check-swallowed-reads.mjs`), wired into `ci:local` and `ci.yml`.

It is narrow on purpose. The tree holds 331 occurrences of the banned spellings and only 83 have the shape
the law is about — the value gets a NAME, so something below decides with it. `void notify(…).catch(…)` is
its own hatch in L2 and needs a different repair; `res.json().catch(() => ({}))` is decoding a body, not a
read that failed. Wiring a gate over all 331 is how a check teaches people to skip its output.

It is a RATCHET, and L2 says why in its own words: *"a scanner with an allowlist is a design admission, not
a solution."* `scripts/swallowed-reads-baseline.txt` is that admission, counted, with 82 entries. A new one
fails; a file whose count DROPPED must update the baseline in the same change, because a debt that quietly
stops shrinking on paper stops being a debt anybody pays.

No eval case. The failure was not a thing an agent got wrong about the configuration — the configuration was
right and unread — so replaying it as a prompt would test the wrong subject.

## The question this leaves open

Every other law in `protocol.md` is prose too. L1, L3, L4 and L5 each name their escape hatches by name, and
each has exactly as much automated readership as L2 had this morning. `pnpm scan` reads for their classes
with a model, on a rotation, over code nobody touched — which is real coverage and is not a gate. Which of
the four has a forty-line regular expression behind it is not a question anybody has asked yet.
