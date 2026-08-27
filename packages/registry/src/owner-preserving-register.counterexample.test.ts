import type { AgentSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryAgentRegistry } from "./agent/agent-registry.js";
import { VersionedStore } from "./versioned-store.js";

// ── OWNER VALUE EXISTS ≠ OWNER VALUE REMAINS VALID UNTIL THE WRITE (arch-review 77) ─────────────────
//
// Registering a successor has to keep the entity with its team: ownership is read off the entity, so a
// version written with no team — or with a STALE one — re-files the whole thing the moment it becomes
// latest. That is the split `teamOfVersion` was made required to prevent, and evolution review wave C paid
// for it once already.
//
// The spelling that looks correct is a read then a write:
//
//     owner = teamOfEntity(id)          ← Team A
//     …ownership transfer lands…        ← now Team B
//     register(successor, owner.teamId) ← writes Team A
//
// and the entity's versions come apart. Detecting it afterwards is the write-then-verify shape arch-review
// 76 removed one layer up, so the value is not carried at all: the store resolves the owner where the write
// happens. Ownership moves the ENTITY (`moveToTeam` re-files every version), which is what makes a single
// read inside the write a faithful answer rather than a guess about ordering.
//
// Seen RED with the read-then-write spelling, observed:
//   the successor was filed under the team that no longer owns the entity: expected 'team-a' to be 'team-b'
//
// ⚠️ The first draft of this file drove the move with `agents.moveToTeam?.(...)`. `InMemoryAgentRegistry`
// has no such method — an agent is not transferable through that surface — so the optional call was a
// SILENT NO-OP and the case measured nothing while failing for an unrelated reason. Optional chaining on a
// method whose existence is the test's PREMISE is the same permissiveness a hand-written double has when it
// cannot refuse (rule `testing`). The transfer is driven through the store, where it is a real operation
// and where both registries delegate.

const spec = (version: string): AgentSpec =>
  ({ id: "a1", version, instructions: "x", mcpServers: [], capabilities: [] }) as unknown as AgentSpec;

// The primitive both registries delegate to — the in-memory store takes only its label; team, origin and
// soft-delete are unconditional there (only the Postgres twin needs to be told which columns exist).
const store = () => new VersionedStore<AgentSpec>("agent");

describe("[R77 COUNTEREXAMPLE] a successor is filed under the owner at the moment of the write", () => {
  it("uses the team the entity has NOW, not the one a caller read earlier", async () => {
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice", "team-a");

    // A caller resolves the owner here…
    expect(agents.teamOfVersion("acme", "a1", "1.0.0")).toBe("team-a");

    // …and the entity moves before the successor lands. A REAL operation, not an optional call that may
    // quietly do nothing.
    agents.moveToTeam("acme", "a1", "team-b");

    agents.registerPreservingOwner("acme", spec("1.1.0"), "alice");

    expect(
      agents.teamOfVersion("acme", "a1", "1.1.0"),
      "the successor was filed under the team that no longer owns the entity",
    ).toBe("team-b");
    // …and the entity is not split: every live version answers the same team.
    expect(agents.teamOfVersion("acme", "a1", "1.0.0")).toBe("team-b");
  });

  it("leaves an UNOWNED entity unowned rather than inventing a team", () => {
    // Absent is the workspace's, never everyone's — and never a value to fabricate (rule `api-layer`).
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice");

    agents.registerPreservingOwner("acme", spec("1.1.0"), "alice");

    expect(agents.teamOfVersion("acme", "a1", "1.1.0")).toBeUndefined();
  });

  it("preserves the owner for the FIRST version of an id too — there is nothing to inherit", () => {
    // The control: a successor of nothing has no owner to preserve, and that is unowned rather than an
    // error. A store that threw here would make the one call site conditional again.
    const agents = store();

    agents.registerPreservingOwner("acme", spec("1.0.0"), "alice");

    expect(agents.teamOfVersion("acme", "a1", "1.0.0")).toBeUndefined();
  });

  it("REACHES the registry surface the adoption actually calls", () => {
    // The delegation, because the counterexample above proves the primitive and the adoption calls a
    // registry. A method that existed only on the store would leave the composition unable to use it —
    // which is this series' "a constructed capability is not a delivered one" in miniature.
    const registry = new InMemoryAgentRegistry();
    expect(typeof registry.registerPreservingOwner).toBe("function");
  });
});
