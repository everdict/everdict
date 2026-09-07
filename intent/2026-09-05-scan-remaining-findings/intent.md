# Intent: the rest of the first full scan sweep

Author: pnpm scan (scopes `execution`, `agent-runtime`, `api`) — two verified by hand, three reported. Status: shipped

Shipped: ebcd25a1

Design: none — five independently-triaged findings, each with the source read and the failing input stated.

## Problem

The first pass over all eight scan scopes returned ten findings. Three are already filed
(`scan-contracts-outbound-credentials`, `scan-domain-plane-attribute`,
`scan-workspace-delete-allowlist`). Five remain, and they are recorded here rather than left in `.git/`,
which does not travel with a clone.

### Verified by reading

**A failed registry read is consumed as "not registered"** — `apps/api/src/composition/sandbox.ts:109`.

    await harnesses.get(tenant, ref.id, ref.version ?? "latest").catch(() => undefined)

This is the literal shape rule `protocol` L2 forbids: *"Never `.catch(() => [])`"*. A registry outage and an
unregistered harness produce the same value, so a session resolving a harness that IS registered falls back
silently to whatever the undefined branch does. Nothing here can see it — `pnpm authz-optional` asks about
authorization inputs, and this is a capability read.

**Authority is reserved before the check that would refuse it** — `packages/backends/src/orchestrators/k8s.ts:1667`.
`K8sBackend.dispatchVerifier` calls `hooks.authority.reserve(work)` — a durable ledger write — before the
network-enforceability check inside `buildK8sJob` can refuse the dispatch. Rule `protocol` L1 is
*authority before effect*; this is the reverse, a reservation that survives a refusal. Reported at medium
confidence and the ordering was confirmed by reading; what was NOT traced is whether a refused dispatch
releases the reservation somewhere downstream.

### Reported, not verified

- **`packages/agent-runtime/src/kernel/loop.ts:773`** (high) — every tool in `spawnTools` is wrapped
  `intrinsic: true`, including ones wired conditionally. Not read.
- **`packages/agent-runtime/src/context/compaction.ts:143`** — rung-1 microcompact clears old tool-result
  bodies by age and size with no special case for a ToolSearch result, so the schemas a later call depends on
  can be dropped while the call is still expected to work. Not read.
- **`apps/api/src/api/harness/harness.routes.ts:34`** (medium) — zod validation runs before
  `gate(principal, "harnesses:register")`, so an unauthorized caller receives schema feedback before being
  refused. ⚠️ The scanner's claim that this is *"unlike every other door"* was **not** verified, and the
  ordering is at least consistent within this file (lines 39 and 104 do the same). Parsing before authorizing
  is also a defensible choice. Triage this one against the codebase rather than against the summary.

## Proposed outcome

Each is triaged and either becomes a change through the gates, is declared as accepted with a reason, or is
shown not to be a finding. All three are acceptable outcomes; leaving them in a JSON file that does not travel
is not.

## Affected users and systems

`apps/api/src/composition/`, `packages/backends/src/orchestrators/`, `packages/agent-runtime/src/`,
`apps/api/src/api/harness/`.

## Constraints

- **A confidence is the scanner's rating of itself.** Two of these were read; three were not, and this file
  says which is which. Treating an unverified medium as a defect is the same error as ignoring a verified one.
- Nothing here changes product code. A scan files; a person triages.

## Open questions

- Should the `.catch(() => undefined)` shape get a scanner of its own? It is the L2 law, it has now appeared in
  a scan rather than a review, and `pnpm authz-optional` is the nearest existing check while asking a
  different question.

## Shipped — what each of the five turned out to be

All five were read against the codebase. Four were real and are repaired; the fifth was real about its own
door and wrong about the population, which changed the repair from a patch into a check.

**① A failed registry read consumed as "not registered"** — `54a28904`. Real, and worse than filed. The
service-conversation lane answering a registered service harness with the process resolver's 404 is merely
the wrong status; the session lane carries on with `spec === undefined`, and `makeHarness` does not refuse
that — a `spec?.kind === "command"` miss falls into a switch on the id, so `claude-code` returns a
`ClaudeCodeHarness` built from nothing. A workspace whose registered instance pins a model and an env booted
the bare built-in, provisioned a container for it and billed the session, with nothing in the record saying
the registry had not been read. One helper owns the read for both sites now; `NotFoundError` is the only
permanent answer.

**② Authority reserved before the check that refuses it** — `2702a038`. Real, and the open question is
answered: the reservation does NOT leak — `verifierOperation` settles the attempt `failed` in its catch — so
the cost is the effects, not the ledger. Two of them, both avoidable: a durable reservation naming a container
that will never exist, and a namespace created in the tenant's cluster for it. The agent lane and Nomad both
put the refusal first, with a comment saying why (arch-review 58 W5); this longhand copy missed the move, for
the second time at the same seam.

**③ `spawnTools` all wrapped `intrinsic: true`** — `3ee28118`. Real as a latent defect, NOT as a live escape,
and the difference is the finding. `intrinsic` exempts a tool from BOTH envelope guards, and `spawn_teammate`
creates another autonomous agent in the workspace's fleet — its own declaration says "NOT read-only: spawning
delegates standing WRITE authority". No lane wires those host hooks together with an envelope today, so no
boundary was crossed; what existed was a capability ungoverned the moment one did. Intrinsic is decided per
tool now. The composition comment in `chat.ts` enumerated the kernel's additions wrongly and closed with "the
test says so"; there was no such test, and now there is.

**④ Microcompact clears ToolSearch results** — `550785c6`. Real, live, and the sharpest of the five. Discovery
was re-derived every turn from the transcript, and compaction is licensed to edit the transcript — so a
select-form search over MCP tool names crossed the 400-char clear threshold, the parse failed, and every tool
it had loaded left the outbound `tools[]` mid-procedure while the prompt began offering them again as
undiscovered. The repair holds the set instead of teaching compaction about ToolSearch, which answers all
three rungs of the ladder rather than the one the finding named.

**⑤ Validation before the gate on `POST /harnesses`** — `ebcd25a1`. Real about the door, wrong about the
population, and the intent was right to say so: the scanner's *"unlike every other door"* did not survive a
census. **45 of the 138 handlers that spell both `gate` and `safeParse` take them in that order, across 21
resource slices.** It is not an authorization bypass — `gate` still runs before the service — so what it costs
is a refused caller being handed the schema's opinion of their body first, and a third of the doors
disagreeing where nobody can see an anomaly. Repairing two doors would have bought a repair and not a rule, so
the outcome is `pnpm gate-order`: a ratchet at 43, with the two harness doors repaired in the same change.

## What this found about the harness itself

Two things, neither of them in the five.

**`pnpm swallowed-reads` reported the file in finding ① clean, twice over** — `75f663ff`. Its statement joiner
only pulled in continuation lines opening a member access, so a ternary the formatter broke across lines never
became one logical line; and even joined, the pattern demanded `= await` ADJACENT, which a conditional never
is. This is the SECOND time that scanner has been found blind over a region it reported PASS on, after the
missing `.tsx` glob, and both times by something else looking — a review, then a scan. That answers this
intent's open question, which asked whether the shape deserved a scanner of its own: it has one, and the
lesson is that a ratchet's PASS is a statement about what its pattern can see.

**And widening it found the sibling** — `28909105`. `verifyManifest` — the function answering whether a batch
could be reproduced today, which is the claim this product sells — spent a store outage as "the harness is
missing", "the model binding no longer resolves", and three separate "the dataset is gone". Its vocabulary
already had the honest word (`unverifiable`, what it says when no registry is wired); both reads now use it.

## Note — the census is the part worth keeping

Finding ⑤ arrived with a confidence, a location and a claim about every other door, and the claim was the only
part that decided what to build. A scanner rates itself; a census counts. Before repairing a door because it
differs from its siblings, count the siblings — the answer here turned one patch into one check and 43
recorded deviations somebody can now see.
