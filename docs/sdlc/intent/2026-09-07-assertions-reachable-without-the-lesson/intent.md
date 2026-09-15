# Intent: three cases died of one disease, and the drill can only report the symptom

Author: Claude (session closing the scan intents), from four drills in one evening. Status: draft

Design: none — one named defect in the eval instrument, with the three cases that exhibited it and the
mechanical check it implies.

## Problem

Three eval cases were found GREEN under their own removal drills on 2026-09-07. Read one at a time they look
like three unrelated retirements. Read together they are one sentence:

> **An assertion is answerable without the lesson when one of its alternatives is reachable from the tree the
> drill leaves standing, or from what a capable model already knows.**

| case | assertion | why it was answerable anyway |
|---|---|---|
| `provenance-at-the-source` | `provenance\|re-derive\|at the source\|carried\|source` | `source` is a word any competent answer to its own question uses |
| `biome-write-is-not-evidence` | `unsafe` | the name of a distinction the TOOL documents; a model that read those docs answers cold |
| `sibling-doors-guard-alike` | `guard-siblings\|baseline` | `guard-siblings` is a live `package.json` script name and the check's own filename; `baseline` names five files in `scripts/` |

The drill can see none of this. It removes the `neutralize` strings from the `subject` files and asks whether
the case still passes — a yes/no about ONE run, with no vocabulary for *why*. So the same finding arrived three
times as "flaky", "green", "green again", and each time the diagnosis came from a person reading the case
rather than from the instrument.

The exclusivity check is the closest thing here and it asks a different question: does some file outside
`subject` carry EVERY `neutralize` needle. That catches a copied LESSON. It cannot catch an assertion whose
alternative is one ordinary word, or one live script name, because a file carrying one needle is not a copy —
and `evals/run.mjs` says so deliberately: *"One needle alone is not a leak."* True, and beside this point.

## Proposed outcome

A case cannot be written whose assertion is satisfiable from what the drill leaves standing. Concretely, the
check that does not exist yet: **for each `mustMatch` alternative, after neutralization, is that string still
present in a tracked file the session can read?** If it is, the case is answerable by grepping and says so at
load time — the way a `neutralize` string that matches no line already fails at load.

That would have refused all three of these when they were written, which is the test of whether it is the
right check.

It does not close the other half — an alternative a MODEL knows without any file, which is what
`biome-write-is-not-evidence` really died of. Nothing mechanical can see that; what can is asking, of every
assertion, **who owns this word** — this repository, or the tool, or the language. That belongs in
`evals/README.md` as the question a case must answer before it is written, next to the one already there
("can the CODEBASE answer this?").

## Affected users and systems

`evals/run.mjs` (the load-time check), `evals/README.md` (the question), and every case ever written — the
suite is two cases, so the cost of applying it retroactively is two readings.

## Constraints

- **The suite is two cases and one of them is uncertified.** Retiring `sibling-doors-guard-alike` tonight
  would make it one, and a fourth retirement in one evening is treating the symptom. It stays, and
  `--drill-status` reports it honestly as green-under-drill, which is what that status line is for.
- **A check over `mustMatch` alternatives must not refuse a legitimately private name.** `EVERDICT_TRUST_DATABASE_URL`
  — the surviving certified case's assertion — appears in tracked files too, in the very rule that carries the
  lesson. The check therefore asks about presence AFTER neutralization and in files OUTSIDE `subject`, or it
  refuses every case including the good ones.
- Each drill is a real agent call. A check that answers this by grepping costs nothing and answers it before
  the call, which is the whole argument for building it.

## Open questions

- Should a case declare `mustMatch` alternatives it KNOWS are reachable, with a reason, the way every other
  allowlist here works? Or is a reachable alternative always a defect?
- `guard-siblings` is reachable because the check's own script is named after it. Is a case whose assertion is
  a control's NAME ever measurable, given every control is named in `package.json`?
- The suite is small enough that the honest next move may be writing cases rather than fixing this check
  first. Both are open; the coverage problem is stated in `evals/README.md` and this one is stated here.
