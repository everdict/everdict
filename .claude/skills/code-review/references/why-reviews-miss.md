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
