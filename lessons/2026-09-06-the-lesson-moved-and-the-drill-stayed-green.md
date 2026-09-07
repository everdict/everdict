# The lesson was copied into a second file, and the drill that certifies it never noticed

Date: 2026-09-06
Found by: the AI-native SDLC audit's removal drill, run by hand against one case picked because it was
the cheapest — so, by an accident of ordering, one day after the copy landed.

## What was believed

That a case whose `neutralize` strings matched a line in one of its `subject` files was measuring that
line. The runner refuses a case whose needles match nothing, and that refusal was read as the whole
guarantee: if the sentence is there to remove, the drill removes it, and a red drill means the sentence
steered. The case had passed its drill when it was written. Nobody thought of the drill as something with an
expiry.

## What made it invisible

The day before, a lesson was written about reading a shell pipeline's exit code. Its second paragraph quoted
the sibling warning from rule `ci` — the one about a formatter exiting 0 without applying its unsafe
fixes — because the two mistakes are the same shape. That paragraph, plus this suite's own README (which
shows the case as its worked example), meant the sentence the drill deletes from `CLAUDE.md` and rule `ci`
now also lived in two files the case did not name. The session under test may `Grep` the whole tree. It did,
found the copy, and answered from it.

Three things kept every gate green:

1. **The presence check asks the wrong direction.** "Is the needle somewhere in `subject`?" is satisfied by
   one file forever, however many others come to carry the same sentence.
2. **A drill result was a terminal line.** Nothing recorded that this case had ever gone red, when, or
   against which bytes — so nothing could say it had stopped being true.
3. **Lessons are supposed to be copied.** `lessons/README.md` says an incident's reasoning goes there so the
   next eval case and the next scan get written from it. The copy that broke the drill was the repository
   doing what it says to do.

Running the new check over every case, not the one the audit had found, refused eleven of twenty. Five
protocol-law cases had leaked into the protocol skill's case-law reference; one had leaked into a shipped
intent; one into a guide page. The one the audit found was the one the audit happened to try.

## What would have caught it earlier

A second loop in the runner, forty lines: for each case, over every tracked markdown file NOT in `subject`,
refuse if the file carries every one of the case's needles. Cheap because the fingerprint is declared by the
case, not inferred; conservative because one shared word ("unsafe" in a rule about casts) is not a leak.

And a ledger line per drill, with a digest of the subjects it certified — so "when was this last shown to
measure anything" is a query, and a subject that moved since is visible without replaying the drill.

## What was done about it

Eval case: none — the failure is in the suite's own accounting, not in what an agent does with the
configuration; replaying it as a prompt would test the wrong subject.

Both of the above, in `evals/run.mjs`: the exclusivity refusal at load (a tracked markdown file outside
`subject` that carries the whole `neutralize` set is refused, with the repair named — add it to `subject`
so the drill removes the lesson there too, or reword it), and every drill appends
`{drill, red, subjects}` to `evals/history.jsonl`. `--drill-status` reports never / green / drifted / red
per case; `--drill-all` re-runs every drill and refuses if any stays green; the full suite refuses to write
the push stamp while any case has no red drill on record. Eleven cases' `subject` lists were widened to the
files that actually carry their lesson.

Not an allowlist. The design pass for this change proposed a per-case "this file may echo the lesson"
declaration, and it was declined: a file a session can read after the drill has removed the lesson
elsewhere makes the drill vacuous whether or not somebody signed for it.
