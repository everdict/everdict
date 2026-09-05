# Two dots made the reviewer cry wolf twenty-one times

Date: 2026-09-05
Found by: reading the first full-range review's findings instead of counting them

## What was believed

That `origin/main..HEAD` is "what this push carries". It is what the CI-parity ledger already used for the
commit list, so the reviewer and the gate's touched-set questions took the same range without anyone asking
whether a range of COMMITS and a range of CHANGES are the same thing.

They are not, and only on a diverged branch does the difference show. `base..HEAD` as a **diff** means "what
HEAD has that base does not" — which, on a branch that is behind base, includes undoing everything base did
since they parted.

## What made it invisible

Every earlier review ran on a small explicit `--range`, where the two forms agree. The first time the default
range was used in anger, this branch was seven commits behind `origin/main`, and the diff was **596 files**
against **122** for the merge-base form. Four hundred and seventy-four files of somebody else's work appeared
as this branch's reversions.

The reviewer then did its job perfectly on the wrong input: twenty-one Important findings, nearly all of the
form "this translates English comments into Korean", "this silently reverts two shipped fixes", "this deletes
a check". Every one of those is main's work, read backwards.

The failure is not the model's and it is not the range's. It is that a reviewer producing twenty-one Important
findings is indistinguishable from a reviewer producing one, until somebody reads them — and a reviewer that
cries wolf is one people stop reading, which is the failure this repository names in `REVIEW.md` for scanners
and had just built into its own reviewer.

## What would have caught it earlier

Diffing the two forms once, at any point, on any diverged branch: `git diff --name-only A..B | wc -l` against
`A...B`. Ten seconds.

Or, structurally: noticing that the same string was serving two different questions. The commit ledger asks
*which commits would be pushed* — `rev-list base..HEAD`, correct. The reviewer asks *what did this branch
change* — a merge-base diff. Reusing the range expression for both was the whole mistake, and it was reused
because it was already there.

## What was done about it

Three dots in the reviewer and in the gate's `configChanged`/`productChanged` questions. The commit list keeps
two dots, which is right for it.

No eval case: this is not a lesson an agent applies in a session, it is a defect in one expression. No new
check either — a checker for "did you mean three dots" would fire on the one place where two is correct. What
pays here is the count in the failure itself, which is why the reviewer prints the file count next to the
range on every run.

## What it does not mean

Not that the review was wasted. It found five real defects in this session's own tooling on the smaller
explicit range, and it is the run that produced this. The cost was reading twenty-one findings to learn that
nineteen of them were about a diff direction — which is exactly the tax `REVIEW.md`'s nit cap exists to keep
somebody from paying twice.
