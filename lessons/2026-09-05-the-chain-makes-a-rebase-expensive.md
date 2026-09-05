# The intent chain makes a rebase expensive, and that is the feature

Date: 2026-09-05
Found by: looking at the branch's divergence before running the push gates

## What was believed

That the intent chain was a record — artifacts committed in an order a check can verify — and that its cost
was the four commits per change it asks for.

It has a second cost nobody had priced. Every `plan.md` cites the commit that introduced its `intent.md`, and
every shipped intent names the commit that landed it. Across seventeen change directories that is **23
distinct shas cited in 24 files**, and every one of them is a commit any rebase would rewrite.

So `git pull --rebase` on this branch does not just move commits. It turns `pnpm intent-chain` red for the
whole tree, in twenty-four places, with no automatic repair: the shas in those files would have to be rewritten
to match the replayed commits, by hand or by a script nobody has written.

## What made it invisible

Nothing hid it — it had simply never been true before. The chain was five days old and had never met a diverged
remote. The first time it did, the cost appeared all at once and in a form no gate warns about: `intent-chain`
would go red *after* the rebase, when the cheap moment to know was before it.

The deeper reason is that the chain records **identity**, and rebasing is exactly the operation that changes
identity while preserving content. A record that references commits is a record that has an opinion about
history being immutable, and this one had never said so out loud.

## What would have caught it earlier

A sentence in `intent/README.md`. The chain's own documentation explains the ordering rules and says nothing
about what happens when the commits move — which is the first question anyone rebasing should have.

Cheaper still: `pnpm intent-chain` could say how many shas it is trusting when it passes. "The chain holds"
tells you it is intact; "the chain holds — 23 commit references across 17 changes" tells you what a rebase
would cost, at the moment you are already looking.

## What was done about it

Both. `intent/README.md` gains the constraint, and the check reports the count it is trusting.

No eval case: this is not a thing an agent gets wrong in a session, it is a property of the artifact set. No
scan class either — nothing in the source is defective. Recording the decision not to mechanise further is the
answer here, and the count in the check's own output is the cheap half that pays for itself.

## What it does not mean

Not that the chain is wrong. A record that makes history rewriting visible and expensive is a record doing its
job — the alternative is a chain whose references silently point at commits that no longer exist, which is the
failure this whole tree is built to refuse. **Merging costs nothing; only rewriting does.** That is the correct
incentive and it should stay.
