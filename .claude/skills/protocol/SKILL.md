---
name: protocol
description: How Everdict models effects, authority, and decisions — the five protocol laws (authority before effect, unknown is unignorable, provenance at the source, immutable settlement bytes, verified completion), the design checklist to run BEFORE writing an effect path, and the case law behind each law. Use when designing or changing anything that dispatches work, reads a ledger a decision rests on, mints a receipt, publishes/exports, or cancels/tears down.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Protocol — identity as authority

Everdict's whole product is a *defensible verdict*. A verdict is defensible only if every step that produced
it can name what it acted on and prove that name was durable before it acted. That is what this skill is: the
rules for the seams between a decision and an effect.

**Why this skill exists.** Fifty-three architecture reviews found the same defect class over and over, and the
cause was never a missing concept. The concepts were added — `RuntimeWorkRef`, `ReadResult`, `AttemptRef`,
`PublicationOperation`, `JudgmentProvenance`. Each was then consumed as an *annotation*: optional, swallowed,
re-derived, or advisory at the one seam where the next effect begins. Read `references/case-law.md` before
designing; it is the list of exactly how, with file and line.

## The five laws (rule `protocol.md` is the pushed form)
1. **Authority before effect** — no external effect until a store RETURNED proof the identity is durable.
2. **Unknown is unignorable** — a failed read is a third value, consumed by exhaustive match.
3. **Provenance is born at the source** — never re-derive identity from rendered output.
4. **A settlement owns immutable bytes** — decisions reference frozen payloads; `current` is monotonic.
5. **Completion is verified zero** — accepted ≠ gone; terminal means read back.

## Design checklist — run this BEFORE writing the code
Answer in the PR/commit body, not in your head. Any "no" is a design change, not a TODO.

1. **What effect does this path cause outside our process?** (cluster object, sink call, spend, published
   bytes, revoked lease.) If none, laws 1/4/5 do not apply — say so and move on.
2. **What names that effect, and where is that name durable BEFORE the effect?** Which store call returns the
   proof? Does the effecting function *require* the proof as a parameter, or merely hope a hook ran?
3. **Which reads does this path make that a decision rests on?** For each: what are the three answers, and
   what does the caller do on `unknown`? If the answer is "same as absent", stop — that is the defect.
4. **What identity does the output claim?** Is it recorded by the producer, or reconstructed downstream from a
   string, a timestamp, or "the latest row"? Does the same predicate already exist elsewhere?
5. **What bytes does the decision reference?** Frozen with a digest, or re-read at drain time? If something
   else can legitimately change them before the effect runs, the effect is already broken.
6. **What does "done" mean here, and who reads it back?** Which counters must be zero — including unknown
   reads? Does the reconciler use the SAME wrapper as the request path?
7. **What escape hatch does this leave alive?** Optional hook, `void` writer, boolean+optional pair, allowlist
   entry, legacy fallback. Name it and delete it in the same change, or state why it must survive.

## Choosing the shape
| Temptation | What it costs | Use instead |
|---|---|---|
| `onX?: (v) => void` hook before an effect | caller can't tell it no-opped | required param carrying the store's proof |
| `write(...): Promise<void>` | zero rows reads as success | return the row / affected count; throw on zero |
| `{ value?: T; ok: boolean }` | consumers read `value`, ignore `ok` | discriminated union + exhaustive switch |
| `.catch(() => [])` on a ledger read | outage becomes emptiness | `ReadResult<T>`; refuse on `unknown` |
| `metric.slice("judge:".length)` | phantom identities | the owning predicate, imported |
| digest of "current results" at drain | a re-score kills the owed effect | immutable staged key + digest |
| `unverifiable` as a terminal state | the debt leaves the sweep | `verifying` + escalation field |
| a scanner + allowlist | every entry is a place the type failed | make the line unrepresentable |

## Verification protocol
Details in `references/verification.md`. The short form: a counterexample seen RED for the stated reason →
the change → `pnpm protocol-mutations` (neutralize the protocol, the suite MUST go red) → escape hatch deleted.
`pnpm ci:local` before any push; `trust fast (real Postgres)` is required and the local gate does not cover it.

## Topic map
- `references/case-law.md` — every incident: the shape, the wrong reasoning verbatim, the correct shape.
- `references/verification.md` — proving a test proves something; mutation, non-vacuous fixtures, scanners.
- Rules: `protocol.md` (this, pushed) · `testing.md` (vacuous-pass rules) · `backends.md` (placement-specific
  applications of L1/L5) · `ci.md` (the gate).
- Docs: `docs/trust-certification.md` · `docs/architecture/execution-model-design.md`.
