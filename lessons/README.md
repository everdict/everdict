# `lessons/` — what an incident taught, written once

When something goes wrong here, what gets learned currently lives in two places: the commit message that fixed
it, and the header of whichever check was written afterwards. Both are good records of the **fix**. Neither
records the **incident** — what was believed at the time, what made it invisible, what would have caught it
earlier.

Those three sentences are what the next eval case and the next scan get written from, and without them they
are reconstructed from a diff every time.

## Writing one

```sh
cp lessons/TEMPLATE.md lessons/2026-09-05-the-gate-failed-open.md
```

Four questions, and they are four on purpose: anything longer does not get written, and a lesson nobody writes
teaches nothing.

**A lesson is written by a person.** A machine can file an `intent.md` — `pnpm watch-bands` does — but only
somebody who was there can say what they believed at the time, and that belief is the part that made the
defect invisible.

## What happens to one

- an eval case, when the failure was one an agent can be asked to repeat (`evals/README.md`);
- a scan class, when it is a shape rather than an instance (`scripts/scan/SCOPES.md`);
- a check, when it is mechanical — which is what most of `.claude/rules/ci.md` is a list of.

A lesson that produces none of those is still worth keeping. Not everything is mechanizable, and the record of
having decided that is itself the answer to the next person who asks why there is no gate for it.
