# <what happened, in the words you would use out loud>

Date: <when it was found, not when it happened>
Found by: <a person, a gate, a scan, an eval, an accident — accidents count and are worth naming>

## What was believed

What the person who wrote it thought was true. This is the part no diff records and the part that made the
defect invisible; without it the rest is a bug report.

## What made it invisible

Why every gate stayed green. "Nobody looked" is a valid answer once. Twice, it names the gate that should
have.

## What would have caught it earlier

The cheapest thing, not the most thorough. A check that would have cost ten seconds beats a review pass that
would have cost an hour, even if the review pass would also have worked.

## What was done about it

Eval case: `<id>` or `none — <why>`

That line is REQUIRED and `pnpm lesson-evals` reads it. It used to read the prose instead, guessing which
backticked word was a case id, and it was wrong three times in two directions: it read "No eval case" as a
promise and failed the honest answer, then — repaired — it read a claim wearing a negation ("there was no
eval case before; now there is: `x`") as a denial and let a case that does not exist through. A declaration
cannot be misread; a heuristic over prose was re-litigated every time somebody wrote a sentence.

Then say the rest in whatever words fit: an eval case, a scan class, a check, or nothing — and if nothing,
why the answer is nothing. Deciding not to mechanize is a decision, and recording it is what stops the next
person re-deciding it from scratch.
