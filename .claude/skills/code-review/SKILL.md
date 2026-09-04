---
name: code-review
description: How to review a change in this repository so the review finds what diff-reading structurally cannot — who can author this value, what the change made load-bearing, what EXISTING code the change now leans on (a parser it cited instead of opening, a sibling read it forgot to teach), composition of bounds, the residue a conditional guard keeps, adversarial counterexamples, and adapter certification plus commit counting against a real engine. Use whenever reviewing code in any language — a diff, a branch, a PR, a batch before push, "review this", a deep or follow-up review, an audit, or a self-review of work you just wrote.
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

**It has since failed a second time, and this file records that too.** Applied to a 30-commit batch, the six
passes found and closed real P0s and missed three more that an outside review found in the same tree — all
three in code the batch never touched and had started to rely on. Passes are added here only after they are
paid for; these were.

## Run these passes in order. None of them reads the diff first.

**And none of them takes the CHANGE as its subject alone.** That was the second measured failure. Every pass
was phrased "for every value *this change* …", and all three missed P0s lived in code the batch never touched
and had merely come to DEPEND on. Pass 3 exists because of it; passes 4, 5 and 6 each grew the half that looks
outward from the diff — the sibling reads, the residue a predicate leaves behind, the commit boundary a green
engine cannot see.

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

### 3 — The neighbour you now lean on. What did you ASSERT instead of read?
Pass 2 asks what your change made powerful. This asks the opposite, and it is the pass that was missing:
**which existing function, statement or query does your new guarantee now REST on?** Name them, open each
one, and read it against the inputs you now send it — not against the inputs you had in mind.

Three P0s in one review were this shape, and not one of them appears in any diff (case law in
`references/why-reviews-miss.md`): a partial strip justified by what a parser "already ignores"; a paging
read that turned a two-statement seal into authoritative evidence; an attempt-ranked plane selection whose
sibling event read still resolved by clock.

The tell is a sentence in YOUR change describing what ANOTHER component does. **A present-tense claim is
still a claim** — "already ignores", "cannot reach", "is always non-empty", "the twin does the same". Those
read as facts, which is why they slip past the comment-is-a-claim law in rule `protocol`, whose examples are
all future tense. Open the component and check the sentence, or delete the sentence.

### 4 — Composition of bounds. Read the next effect, not your own line.
Every limit, page, batch or cap you add: read what happens AFTER it with that limit in force. A bounded
enumeration followed by an unbounded delete is a permanent leak, and it looks correct on both lines.
Ask the off-by-one out loud: *what happens at limit + 1?*

Then count the SIBLINGS — not the callers. rule `protocol`'s one-lane law says to grep the callers of a
method you changed, and that misses the shape where there is no method: three SQL strings, three route
handlers, three readers answering ONE question, of which you taught two. Ask *how many reads answer this
same question*, and count them in the commit message.

### 5 — Adversarial counterexample. Not "does it work" — "what does it now permit".
Every capability gets a test written from the attacker's chair: a producer forging the field, a caller
naming somebody else's key, a trace quoting a coordinate it does not own. A suite of confirmations is not
a review; it is the author's intent, restated.

**And when a guard is CONDITIONAL, the counterexample belongs to the residue.** A strip that deletes the
field *when P* leaves every ¬P value reaching the same consumer, authored by the same producer. The values
you kept are the ones nobody reviewed: the `artifact://` P0 was closed by a scheme test, and
`https://foreign-host/<our-bucket>/<key>` — the same field, the same producer, the same consumer — had no
test at all. Write the boundary case for what SURVIVES the predicate, not only for what it removes.

**AND A REFUSAL NEEDS THE COUNTEREXAMPLE FROM BOTH SIDES.** The rule above is written for a GUARD — a strip,
a filter — where the danger is what SURVIVES. A REFUSAL is the same predicate pointed the other way, and its
danger is what it WRONGLY REJECTS, which no amount of testing the rejected class can find. A validator with
only refusal cases is a validator whose false-positive rate is unmeasured, and a false refusal is silent:
it removes a case from an exam, a file from a build, a candidate from a batch, and nothing downstream says
anything was lost.

Measured, twice in one session, in one 90-line file:

    refused 10 cases   comparing an answer workbook's context to an input's, `{} == {}` matched
                       (an extraction task's answer sheet holds nothing outside the answer range)
    refused 70 cases   searching for a non-identity permutation and taking the first hit — when two test
                       cases differ only inside the answer range, the identity AND a swap both hold

Both shipped with a counterexample for the case that MUST be refused (a genuinely swapped answer key) and
none for the cases that must be ADMITTED. Both were found by reading the check's OUTPUT — seventy refusals
all naming the same permutation — rather than by reading the check.

- **Name the admitted classes before writing the predicate**, the way pass 5 names the kept classes, and
  write one boundary case for each: the empty one, the ambiguous one, the one that coincides by accident.
- **A refusal's error message is evidence.** If a hundred refusals give the same reason, that is a
  distribution, and a real defect distribution is not uniform. Read the output, not the rule.
- The shared root of both, and of every finding in this session: **an existence check standing where a
  discriminating one was meant.** "Something matched" is not "the right thing matched"; "a permutation
  exists" is not "the identity does not hold"; "the arms agree" is not "the measurement works".

### 6 — The adapter is not its twin, and one statement is not one commit.
A decision that lives in SQL, a constraint, a conditional `UPDATE`'s `WHERE`, a jsonpath — is certified by a
real engine or by nothing. In-memory twins run different code, and a fake client that asserts on SQL TEXT
answers happily to a statement no planner accepts. Run it, or say you did not.

Then ask the question a green engine cannot answer: **how many independent commits does this logical write
take?** Name them, and for each adjacent pair say what a READER is served if the process dies between them.
A passing test never crashes there, so atomicity is invisible to both the twin and the engine — and a header
that claims N rows over zero rows is served as an *empty* answer rather than a missing one, which is the
worst direction for evidence to fail in.

### 7 — Stop on the passes, never on green.
No gate in this repo can see passes 1–5. Finish by writing down **what you did not verify** — the lane you
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

## The check that is owed, and why it is not here yet
Pass 5's residue rule is mechanisable exactly once: `pnpm untrusted-ingress` already owns the strip functions,
and it could refuse a CONDITIONAL delete of a platform-authored field — the field goes, or the surviving value
class is declared with the consumer that was read for it. It is not added here because it would be RED on
`main` today, and a gate that lands before its fix teaches people to bypass gates. It lands in the same change
as the strip.
