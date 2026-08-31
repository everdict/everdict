# Why a self-review misses what an outside review finds — and the case law per pass

This file is the diagnosis that produced the passes in `SKILL.md`. It is written from a measured event, not
from principle: one batch of eleven commits, reviewed three times by its own author, then reviewed once from
outside. The self-reviews found real defects. The outside review found three P0s in the same tree, using no
information the author did not have.

## What each round actually asked

| round | axis | what it assumed |
|---|---|---|
| 1 | collaboration seams — decorator chain, port consumers, who reaches whom | the producer is benign |
| 2 | design conformance — code vs the design document that owns the seam | the producer is benign |
| 3 | adapter SQL — statements no in-memory twin executes | the producer is benign |

Three different axes, one shared blind spot. Not one round asked **who can author this value**. That is the
whole gap, and it is structural rather than a lapse of attention: each round took the change as its subject,
and the trust boundary is not a property of a change.

## Pass 1 — Authorship. Case law.

**arch-review 66 — the GC coordinate on `CaseResult`.** The platform's cleanup coordinate was added to the
document a runner submits. A workspace-controlled runner could therefore name the objects the settlement
would delete. The rule written then is still in rule `protocol`, in these words: *the untrusted execution
surface, the canonical measurement, and the platform's private lifecycle state are three schemas.*

**arch-review 121 — the offload refs, one layer up.** `TraceEvent` carries `textRef` / `argsRef` /
`outputRef` / `attributesRef`. The same `TraceEventSchema` validates producer submissions (`POST` job
results, judge tools parsing caller-supplied trace JSON), and no ingress strips those fields. Meanwhile the
resolver takes any `artifact://…` string, strips the scheme and reads that key from the shared store without
checking tenant, run, emitter, field or digest — and retention takes any such string as authority to DELETE
the object. So a producer submitting

    { "kind": "tool_result", "output": "harmless", "outputRef": "artifact://<foreign key>" }

substitutes evidence it never produced, can read bytes it does not own, and — with a whole string value that
is a bare ref — can get somebody else's object deleted when its trajectory expires.

⚠️ **The author got within one step and stopped.** A test was written for the prose case
(`"saved it, see artifact://<key>"` must NOT match). The question being asked was "does my matcher
over-match?" — an author's question. The attacker's question is "what can I make this do?", and it was never
asked. A near-miss like this is the strongest evidence that the missing thing is a PASS, not more care.

## Pass 2 — Blast radius. Case law.

The `*Ref` fields had existed for months and appear in no diff of that batch. What the batch changed was
their consequence: `resolve` was wired to the HTTP route and the MCP tool (a read anyone with `runs:read`
can now trigger), and retention was wired to object deletion. **A field was promoted from annotation to
capability without its declaration being touched**, so every diff-shaped review was structurally blind to it.

The question that finds it: *what did this change make load-bearing that already existed?*

## Pass 3 — Composition of bounds. Case law.

    const refs = await this.inner.payloadRefsOlderThan(cutoffIso, PAYLOAD_SWEEP_LIMIT); // 5_000
    …delete those objects…
    return this.inner.deleteOlderThan(cutoffIso);                                        // ALL expired rows

Both lines are correct alone. Together, expired rows holding 5_001 distinct refs lose 5_000 objects and every
row — so the 5_001st object is named by nothing and no later sweep can find it. Deterministic, permanent.

⚠️ The author wrote, in that exact function, *"the rows it could not account for are simply deleted by a later
pass"* — the comment-promises-another-component law from rule `protocol`, broken in the file where it was
being cited. **A comment asserting a future pass is a claim about a mechanism; grep for the mechanism.**

The question that finds it: *what happens at limit + 1?*

## Pass 5 — The adapter is not its twin. Case law.

One trust scenario, on its first execution, found two defects that every unit test had been green over:

- `jsonb_path_query(body, '$.**{0 to 6}.*ref')` — not valid SQL/JSON path. Postgres answered
  `syntax error at end of jsonpath input` on every call, and because the decorator awaits that read before
  deleting anything, the whole retention sweep threw in every Postgres deployment.
- `SELECT … ordinality, value, (bytes_in.value)::int FROM unnest(…) AS body_in(value, ordinality) JOIN
  unnest(…) AS bytes_in(value, ordinality)` — `value` is ambiguous, so split-plane event writing had been
  failing since the day it shipped.

Neither is visible to reading. The in-memory twin runs its own JavaScript; the fake `SqlClient` asserts on
SQL **text**. Both answer happily to statements no planner accepts.

## Pass 6 — Why green became the stop condition

The batch's wall-clock was dominated by making gates green. No gate in this repository can see passes 1–4:
there is no scanner for "a producer-parseable schema carries a field the platform treats as a capability",
and no test asserts an attacker's absence unless somebody writes it. Green therefore measured the gates'
coverage, and that silently became the review's stopping condition.

## The two asymmetries, stated so they can be compensated for

- **Model.** The author reviews with the model that produced the defect. Compensate by preferring questions
  whose answers cannot come from intent — *who can write this?* rather than *is this right?*
- **Incentive.** The author is optimizing to land; a reviewer only has to find. Compensate by naming the
  passes run, so a skipped pass is visible rather than absent.

## What should become a scanner

This repository's discipline is that a prose law which fails once becomes a machine check. The authorship law
failed **three times** — the `CaseResult` GC coordinate (66), the offload refs (121), and the billing
provenance (122), the last of which decided who pays. It is a scanner now: **`pnpm untrusted-ingress`**
refuses a bare producer-document schema anywhere outside its own declaration, so a door added later cannot
quietly parse `CaseResultSchema` instead of `UntrustedCaseResultSchema`.

What the scanner does NOT do is the rest of pass 1. It knows the three documents it was taught; it cannot
tell you that some OTHER value is a capability. `traceRef` was found by reading — the control plane resolved
a secret the producer named and sent it where the producer said — and no check would have asked that
question. The scanner closes the regression, and the pass still has to be run.

---

# The SECOND measured failure — six passes, thirty commits, three P0s missed

The passes above were written from one event and then applied to the next batch: thirty commits, several
self-review rounds, every gate green, a push. An outside review of the same tree found three P0s. None was
information the author lacked; all three were verified from the tree afterwards in under twenty minutes.

What makes this event worth a section is that the earlier diagnosis does not explain it. Round 1–3 shared
"the producer is benign". These rounds did NOT — pass 1 ran, and it is what found and closed the
`artifact://` forgery in the first place. The blind spot moved.

## The shared property: every pass took THE CHANGE as its subject

| P0 | the pre-existing code | what the change actually did to it |
|---|---|---|
| legacy URL signing | `S3ArtifactStore.keyOf` parses ANY host whose path starts with `/<bucket>/` | the new strip decided which values reach it |
| Postgres split seal | header INSERT and `writeEvents` are two statements, no transaction | the new paging read made it authoritative evidence |
| ClickHouse event bytes | `argMin(body, sealed_at)` — first write by clock | attempt-ranking was added to two sibling reads, not this one |

Pass 2 asks *what did this change make load-bearing* and finds values it PROMOTED. It does not find code the
change came to LEAN ON, and those are different sets — which is why pass 3 was added.

## Case law 1 — a conditional strip, defended by a claim about the parser

`stripPlatformAuthoredFields` deletes `screenshotRef` / `outputRef` / … only when the value starts with
`artifact://`. The comment above it states the reasoning, and the reasoning is the defect:

> ⚠️ THE RULE IS THE SCHEME, NOT THE FIELD NAME. […] `os-use` legitimately reports where it captured a
> screenshot INSIDE the compute (`/tmp/shot.png`), which names nothing of ours — **`publicUrlFor` already
> ignores it**, and deleting it would throw away a producer's own report.

`publicUrlFor` → `keyOf` ignores a RELATIVE path, because `new URL(ref)` throws. It does not ignore an
absolute URL on a foreign host: the comment there says the host is *deliberately* not compared, so a legacy
ref minted before the public base was configured still resolves. Put together, a producer submitting

    "screenshotRef": "https://attacker.invalid/<configured-bucket>/<target-key>"

survives the strip, is stored, and on the next run-detail read is handed to `publicUrlFor`, which returns a
freshly signed URL for `<target-key>` in the deployment's one artifact bucket.

Two lessons, and the second is the general one:

- **The residue is the finding.** A predicate splits a field's values in two, and review attention follows
  the half that was REMOVED. The surviving half has the same author, the same field and the same consumer.
  The counterexample file for this fix pins `artifact://forged` → stripped and `/tmp/local` → kept, and has
  no case at all for the third shape that exists.
- **A present-tense claim about another component is a claim.** rule `protocol`'s comment-is-a-claim law was
  read and cited during this work; its examples are all future tense ("the caller handles", "the sweep
  retries"), and "already ignores" does not pattern-match as a promise. It is one.

## Case law 2 — two statements, one header, no transaction

    const inserted = await client.query(`INSERT INTO everdict_trajectories … body_split=true, event_count=$5
                                          … ON CONFLICT (run_id) DO NOTHING RETURNING run_id`);
    if (inserted.rows.length > 0) {
      await this.writeEvents(input.runId, emitter, items);   // ← a second statement, a second commit

If `writeEvents` throws, the header stands claiming N events over zero rows, and the retry hits
`ON CONFLICT DO NOTHING` → `created: false` → no repair path. The reader then serves an empty page and the
collector converges on `[]`: **not "evidence missing" but "evidence empty"**, which every downstream consumer
accepts as an answer.

This is not hypothetical here. `writeEvents`' SQL carried an ambiguous `value` column and was rejected by the
planner on every call until a real-Postgres run found it — the exact window in which header-only rows would
have been produced.

Why pass 5 (as written) could not see it: it asks *has an ENGINE run this?* A green engine proves the
statements EXECUTE. Atomicity is only observable at a crash, and a passing test never crashes. Hence the
question added to pass 6: **how many independent commits is this write, and what is served between them?**

## Case law 3 — the sibling read with no method to grep

The exact-attempt fix introduced one shared constant so the plane header and the body would agree:

    const ATTEMPT_RANK = "if(attempt_id = {attemptId:String}, 0, if(attempt_id = '', 1, 2))";

It is applied to `planeRows` and to the LEGACY (unsplit) body read. The SPLIT event read — the one that
serves every modern plane — still resolves purely by clock, on a table that has no `attempt_id` column at
all:

    SELECT seq, argMin(body, sealed_at) AS body_first FROM …everdict_trajectory_events
     WHERE run_id = {runId} AND emitter = {emitter} GROUP BY seq

and its comment claims the parity that is missing: *"the same first-write-wins resolution the plane rows
use"*. The plane rows rank by attempt FIRST and break ties by clock; these rank by clock alone. So a receipt
selecting attempt B is served B's header over A's bytes, and both halves are internally consistent.

one-lane-only, again — but the law's mechanism (`grep -n` the other CALLERS of the method you changed) cannot
reach this: there is no method, only three SQL strings answering one question. Hence the question added to
pass 4: **how many reads answer this same question?**

## What this second failure says about adding passes

Both events produced passes, and both times the pass was a QUESTION rather than a rule about correctness —
"who can write this", "what do you now lean on", "how many commits", "how many reads". That is the only kind
that survives self-review, because the author cannot answer it from intent. A pass phrased as "check that X
is correct" is answered by the same model that wrote X.

The reviewer's own summary of the batch is the tell worth remembering. It ended with a section titled *what
is still open* — and every item in it was something the change had ADDED. Nothing in that section named code
the change had started to depend on, because nothing had asked.
