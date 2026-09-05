# Intent: a member can forge the provenance an agent's loop guard trusts

Author: pnpm scan (scope `agent`, sonnet, 90acbdab) — both verified by hand before filing. Status: draft

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
