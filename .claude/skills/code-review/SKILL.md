---
name: code-review
description: How to review a change in this repository so the review finds what diff-reading structurally cannot — the trust-boundary pass (who can author this value), blast radius over unchanged fields whose MEANING changed, composition of bounds, adversarial counterexamples, and adapter certification against a real engine. Use whenever reviewing code in any language — a diff, a branch, a PR, a batch before push, "review this", a deep or follow-up review, an audit, or a self-review of work you just wrote.
allowed-tools: Read, Grep, Glob, Bash
---
# Code review — the passes a diff cannot do

A review that reads the diff finds what the author already thought about. Everything this repository has
shipped as a P0 was outside the diff: a field that did not change while its MEANING did, a bound composed
with an unbounded neighbour, a producer nobody modelled as hostile, SQL no engine had ever planned.

**This skill exists because of a measured failure.** Three self-review rounds over one batch (collaboration
seams, design conformance, adapter SQL) found real defects and missed three P0s that an outside review found
immediately. Every fact needed was in the tree. What was missing was a method — the diagnosis and the case
law are in `references/why-reviews-miss.md`, and each pass below is one of those misses turned into a
question you can ask without knowing the answer in advance.

## Run these passes in order. None of them reads the diff first.

### 1 — Authorship. Who can write this value?
For every value the change makes load-bearing, name its author: platform, or producer (a harness, a runner,
an OTLP push, a job result, a caller-supplied JSON body). If a **producer** can author it and the platform
treats it as a **capability** — a key it will read, a coordinate it will delete, an id it will join on —
that is a trust-boundary defect no matter how correct the surrounding code is.

    schema-valid   ≠   platform-authored
    present in the record   ≠   this record owns it

The repair is a schema split (untrusted ingress vs stored canonical) plus a strip/reject at every ingress,
and a ledger the platform writes when it mints the capability. Never a validator on the string.

### 2 — Blast radius, not diff. What did this change make load-bearing?
List the values whose DECLARATION is untouched and whose CONSEQUENCE grew. Wiring a read to a transport,
a field to a deletion, a string to a join — each promotes an annotation to a capability without appearing
in the diff. Review those as if they were new, because for the system they are.

### 3 — Composition of bounds. Read the next effect, not your own line.
Every limit, page, batch or cap you add: read what happens AFTER it with that limit in force. A bounded
enumeration followed by an unbounded delete is a permanent leak, and it looks correct on both lines.
Ask the off-by-one out loud: *what happens at limit + 1?*

### 4 — Adversarial counterexample. Not "does it work" — "what does it now permit".
Every capability gets a test written from the attacker's chair: a producer forging the field, a caller
naming somebody else's key, a trace quoting a coordinate it does not own. A suite of confirmations is not
a review; it is the author's intent, restated.

### 5 — The adapter is not its twin.
A decision that lives in SQL, a constraint, a conditional `UPDATE`'s `WHERE`, a jsonpath — is certified by a
real engine or by nothing. In-memory twins run different code, and a fake client that asserts on SQL TEXT
answers happily to a statement no planner accepts. Run it, or say you did not.

### 6 — Stop on the passes, never on green.
No gate in this repo can see passes 1–4. Finish by writing down **what you did not verify** — the lane you
could not run, the engine you did not have, the pass you skipped. A review that ends at "gates green" has
reported the gates' opinion, not its own.

## The two things that make a self-review weaker than an outside one
- **You review with the model that produced the defect.** Prefer questions whose answers you cannot supply
  from intent ("who can write this?") over questions that check your own reasoning ("is this correct?").
- **You are optimizing to land; a reviewer only has to find.** Landing pressure makes green a stopping
  condition. Name the passes you ran, so skipping one is visible rather than silent.

## Depth
- `references/why-reviews-miss.md` — the diagnosis, and the case law for each pass with file, line and the
  wrong reasoning verbatim.
- `references/review-checklist.md` — the per-pass questions, the report shape, and the severity vocabulary.
- Rule `protocol` for the five laws each pass defends; rule `testing` for the vacuous-pass rules a
  counterexample must clear.
