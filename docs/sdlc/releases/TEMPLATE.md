# Release: <tag>

Commit: <full sha this tag points at>
Authorized by: <name>, <date>

## What ships

Which artifacts this tag publishes, and to where. Name them: the binaries, the images, the registry.

## What verified it

Name runs, not intentions.

- `pnpm ci:local` — green at <sha>
- `pnpm ci:commits` — green over <n> commit(s)
- `trust fast (real Postgres)` — <run id or "not run, because …">
- `pnpm agent-evals` — <n>/<n> at <sha>, or "not applicable: no configuration change"
- `pnpm review` — <n> finding(s), <n> Important, and what was decided about them

## What is knowingly shipping broken

Anything Important that was found and accepted, with the reason. Empty is a valid answer and a meaningful
one; "n/a" is not.

## Rollback

The exact command, and where it has been rehearsed. A rollback path that has never been run is a sentence.
