# Review instructions

The policy `pnpm review` applies to every push that carries product code. It is the same policy every time,
which is the point: review quality here used to vary with whoever remembered to ask for one.

Findings **rank and inform**. They do not approve and they do not block — the push gate asks whether the
review happened, never whether it was clean. A person decides what to do about what it found.

## Passes

Run four, and tag every finding with its pass.

- **Authorship** — for every value this change made load-bearing, who can author it? A field the platform
  authors riding on a document a producer submits, an identity re-derived from rendered output, a coordinate
  a caller names. Three P0s in this repository were this shape and nothing else caught them.
- **Leaned-on** — what EXISTING code does this change now rest on that it did not before? A parser it cited
  instead of opening, a sibling query it forgot to teach, a seal it started reading as evidence. Reviews here
  have twice missed defects living entirely in untouched code the change had come to depend on.
- **Bugs** — logic errors, broken edge cases, subtle regressions, and the composition of bounds: a bound
  composed with an unbounded neighbour is the failure, not either half.
- **Compliance** — does the change match its `intent.md`, its `plan.md`, and the rules under `.claude/rules/`
  whose globs it touches? Name the rule, not a feeling.

## What Important means here

Reserve **Important** for a finding that would break behaviour, leak or destroy data, breach a stated policy,
or make a gate certify something it did not check. Everything else is a **Nit**.

A finding that a test would still pass with its subject deleted is Important, not a nit. So is a check whose
corpus is empty.

## Cap the nits

At most five nits per review; summarise the rest as a count. A review that reports thirty nits and one
Important has hidden the Important one.

## Do not report

- generated output: `dist/`, `.next/`, `packages/*/dist/`
- anything a gate already enforces — `pnpm lint`, `typecheck`, and the checks under `scripts/`. Reporting
  what CI will refuse anyway spends the reader's attention on the half a machine already has.
- style and naming, unless a rule names them

## What a finding must carry

The file and line, the pass it belongs to, its severity, and **a concrete failure**: inputs or state that
produce the wrong output. "This looks fragile" is not a finding. If a counterexample cannot be stated, say so
and rank it lower — an unstated counterexample is a suspicion, and suspicions belong in the summary rather
than in the list.

## A finding is graded after it is read

Findings rank and inform, and the gate never asks whether one was clean — but an ungraded finding leaves the
reviewer's precision unmeasured, and the article names that as this play's counter-metric. So after a review
is triaged, each Important finding gets one line in `findings/DISPOSITIONS.md`:

```sh
pnpm findings --record --source review --key <head12> --file <path> \
  --verdict real|false-positive|carried --why "<what made it so>"
```

`carried` means real and deliberately not fixed here — an intent holds it — and it counts toward precision,
because carrying a finding is not disagreeing with it. `pnpm findings` reports the precision and lists what is
still ungraded; an ungraded corpus reads **UNKNOWN**, never 100%.

## Reading the diff is the last pass, not the first

The four passes above are questions about the change's surroundings. Answer them before reading the diff
line by line, because the defects this repository has actually paid for lived in code the diff never showed.
