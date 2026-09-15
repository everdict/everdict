# Intent: a member can forge the provenance an agent's loop guard trusts

Author: pnpm scan (scope `agent`, sonnet, 90acbdab) — both verified by hand before filing. Status: shipped

Shipped: 0c441ad0

Design: none — two named defects with the source read and the failing input stated; the scan wrote the design.

## Problem

### 1 · `causedBy` is platform-authored and a member supplies it

`POST /agent/events` has two branches. The internal-token branch extends the schema and is the trusted path.
The **member-authenticated** branch (`apps/agent/src/server.ts:1245`) parses `eventFieldsSchema`, which
includes:

    causedBy: z.string().min(1).optional(),

and forwards it verbatim through `eventOf(parsed.data)` into `activator.onEvent`.

`causedBy` is the loop guard's key. `apps/agent/src/agent-activation.ts:192` and `:257`:

    if (event.causedBy?.startsWith(`agent:${entry.id}:`)) continue;

The platform stamps that string itself where it means something — `checkpoint-service.ts:644` and `:661` set
it from `decision.verifier.id` and `record.createdBy`, and `revisioned-workspace-fs.ts:145` stamps an
agent-authored publish with it — precisely so an agent does not react to its own effects.

So: **any workspace member can post an event with `causedBy: "agent:<id>:anything"` and silently suppress that
agent's activation for it.** Nothing errors, nothing is logged as a refusal, and the agent simply does not
react. It is a denial of service against a specific agent, spelled as a well-formed request, available to
anyone who can call the endpoint at all.

This is the authorship law — a field the PLATFORM authors, riding on a document a PRODUCER submits, and then
acted on. It is the fifth instance in this repository's recorded history and the second in this scan sweep.
`pnpm untrusted-ingress` cannot see it: that check asks which schema a door parses with, and here the schema
is the door's own, faithfully carrying a field it should never have accepted from this caller.

### 2 · A transient store failure becomes a permanent verdict

`activateDirect` (`apps/agent/src/agent-activation.ts:532`):

    try { spec = await this.deps.registry.get(...); } catch { return { skipped: `agent ${id} not found` }; }

and six lines later:

    const entries = await this.deps.registry.list(input.workspace).catch(() => []);

The first collapses every error — a genuine absence and a connection blip alike — into `{skipped}`, which the
function's own contract two lines above defines as *permanently not runnable*, the verdict that stops a
reaction chain. A throw is what says *transiently busy, retry later*. The second is the literal shape rule
`protocol` L2 forbids, and its consequence here is `skipped: has no creator to act as`.

A brief Postgres blip during a Temporal reaction step therefore ends that chain permanently, for an agent that
exists and is enabled.

## Proposed outcome

`causedBy` is accepted only from the branch the platform authenticates, and the member branch cannot set it.
And a registry read that fails is distinguishable from one that found nothing, so a transient outage produces
a retry rather than a terminal verdict.

## Affected users and systems

`apps/agent/src/server.ts` (the door), `apps/agent/src/agent-activation.ts` (the loop guard and the reads),
and every reaction chain that depends on an agent activating.

## Constraints

- The internal-token branch legitimately sets `causedBy` — the fix is per branch, not per field.
- `{skipped}` and a throw mean different things to the Temporal activity that calls this. Changing which one a
  failed read produces changes retry behaviour, and that is the point.
- Both were read against the source before this was filed. What was NOT traced: whether any other door accepts
  `causedBy` from an unauthenticated or member caller.

## Open questions

- Are there other platform-authored fields on `eventFieldsSchema` that the member branch should not accept —
  `eventId` is the obvious candidate, since it is the idempotency key.
- Should `causedBy` be typed so that only the platform can construct one, rather than filtered at each door?
  The three previous instances of this law were closed by splitting a schema; two doors in, that pattern may
  be the wrong shape for a field rather than a document.

## Shipped

Both, in `0c441ad0`.

**`causedBy`** — repaired as the authorship law prescribes rather than by validating the string:
`memberEventFieldsSchema` carries no `causedBy`, so zod strips a forged one before anything reads it, and
the internally-authenticated branch extends that surface to add the field. The test pins the SHAPE, and says
plainly what it does not do: against the pre-fix source it fails on a missing export (the schema was a local
inside `buildServer`), so it is a regression guard rather than a reproduction of the original request. A
door-level counterexample would need an `AgentActivator` with a registry and a key store, and that setup
would be most of the test.

**The transient outage** — only `NotFoundError` is the permanent `{skipped}` now; every other failure throws,
which is what says retry later, and the creator lookup no longer swallows. Its counterexample was seen RED
for the stated reason (`promise resolved "{ skipped: 'agent sentinel not found' }" instead of rejecting`) and
drives both the spec read and the list, with a genuine absence asserted to still skip.

One consequence worth recording: removing the `.catch(() => [])` made `pnpm swallowed-reads` go RED, because
the debt shrank and the baseline had not. That is the ratchet's other half working — a debt that quietly
stops shrinking on paper stops being a debt anybody pays — and the baseline followed in `dc8ef054`
(132 → 131).

