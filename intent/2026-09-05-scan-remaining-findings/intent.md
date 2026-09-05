# Intent: the rest of the first full scan sweep

Author: pnpm scan (scopes `execution`, `agent-runtime`, `api`) — two verified by hand, three reported. Status: draft

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
