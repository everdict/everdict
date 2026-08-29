# The per-pass questions, the report shape, and what a severity means here

`SKILL.md` states the six passes. This file is what you actually run and what you hand back.

## Before anything: establish the subject

    git log --oneline <base>..HEAD          what is in scope
    git diff --stat <base>..HEAD            how big, and where
    git diff HEAD --name-only               is the tree clean (a dirty shared tree hides everything)

⚠️ In a shared worktree `git diff` can lie — the index lags. Verify with a private index rather than trusting
it: `GIT_INDEX_FILE=$(mktemp) git read-tree HEAD && GIT_INDEX_FILE=… git diff HEAD --name-only`. Never
`export` it: a stray `GIT_INDEX_FILE` reaching a tool that shells out to git makes it enumerate nothing, and
checks that walk the tree then report an empty corpus as success.

## Pass 1 — Authorship

For each value the change makes load-bearing:

- Who writes it — platform, or a producer? Producers here are the harness, the self-hosted runner, the OTLP
  door, submitted job results, and any caller-supplied JSON a tool or route parses.
- Is the schema that validates it reachable from an untrusted ingress? `grep` the schema name across
  `apps/*/src` and look at the routes and tools, not only the store.
- Does the platform consume the value as a **capability** — a key it reads, a coordinate it deletes, an id it
  joins on, a name it dispatches under?
- If producer-authored AND capability-consumed: does any ingress strip or reject it? Show the line, or record
  its absence as the finding.

## Pass 2 — Blast radius

- Which values did this change make load-bearing **without changing their declaration**? A read wired to a
  transport, a field wired to a delete, a string wired to a join.
- For each: review it as new. Its previous review happened when it meant something smaller.

## Pass 3 — Composition of bounds

- List every limit / page size / batch / cap the change introduces or relies on.
- For each, read the NEXT effect with that limit in force, and answer *what happens at limit + 1?*
- Any comment promising a later pass, a retry, a next sweep: grep for that mechanism. If it does not exist,
  the promise is the finding.

## Pass 4 — Adversarial counterexample

For each capability, write the attacker's test before the confirming one:

- a producer forging the field the platform is supposed to author;
- a caller naming a key belonging to another run, member or workspace;
- a record quoting a coordinate it does not own;
- the same request twice, and the second one racing the first.

A counterexample must be seen RED **for the stated reason** (rule `testing`), and its red text recorded.

## Pass 5 — Adapter certification

- Does any decision in this change live in SQL, a constraint, a conditional `UPDATE`'s `WHERE`, a jsonpath, a
  regex over stored text?
- If yes: has an ENGINE run it? An in-memory twin and a text-asserting fake client are not evidence.
- Run it against a THROWAWAY database — never a dev stack. If you cannot, that is a pass you skipped, and it
  goes in the report.

## Pass 6 — Report

State, in this order:

1. **Verified clean** — what you checked and found sound. A review with no negative space is not a review.
2. **Findings**, worst first, each with: the mechanism, the concrete reproduction, and which side is wrong
   (implementation, or the document that describes it — do not assume the document must yield).
3. **What you did not verify** — the lane you could not run, the engine you did not have, the pass you
   skipped. This section is mandatory; an empty one is a claim.

## Severity, as this repo uses it

- **P0** — evidence can be substituted, deleted or read by someone who should not; or a decision is recorded
  that the system cannot support. Release blocker.
- **P1** — the invariant holds today by accident: an unbounded path, an unenforced policy, a lane that
  diverged from its sibling.
- **P2** — a document that no longer describes the code, a second spelling of a kernel concept, a missing
  justification. Real, not urgent.

## Judging document-vs-code disagreement

When the code and the design document disagree, decide which is wrong instead of defaulting to "the document
is stale". Three outcomes, and all three occur:

- **the document is right** — it states an invariant worth keeping and the code broke it (a preview that
  became key-order dependent);
- **the document is incomplete** — the behaviour is correct and was never written down (retention deleting
  payload objects);
- **neither is wrong** — the change added a case the design never considered, which is a DECISION to make
  explicitly and record, not to ship under a review banner.
