import type { AgentSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryAgentRegistry } from "./agent/agent-registry.js";
import { InMemoryHarnessInstanceRegistry } from "./harness/harness-instance-registry.js";
import { InMemoryHarnessTemplateRegistry } from "./harness/harness-template-registry.js";
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

  it("is the surface EVERY successor-writing lane uses, not just the one that found the bug", () => {
    // arch-review 77 closed this window in the campaign adoption lane. `saveAgent`'s auto-bump and the
    // harness re-pin write successors the same way and kept the read-then-write spelling for fifteen waves
    // — the one-lane-only shape this series keeps finding, and the reason the fix is a METHOD rather than a
    // remembered discipline (arch-review 92).
    //
    // A test cannot prove a call site does not exist, so this asserts the SHAPE the lanes must use: both
    // registries carry it, so no lane has to hand-roll the resolution or omit it.
    const agents = new InMemoryAgentRegistry();
    expect(typeof agents.registerPreservingOwner, "the agent lane cannot preserve an owner").toBe("function");
    const instances = new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry());
    expect(typeof instances.registerPreservingOwner, "the harness lane cannot preserve an owner").toBe("function");
  });

  it("REACHES the registry surface the adoption actually calls", () => {
    // The delegation, because the counterexample above proves the primitive and the adoption calls a
    // registry. A method that existed only on the store would leave the composition unable to use it —
    // which is this series' "a constructed capability is not a delivered one" in miniature.
    const registry = new InMemoryAgentRegistry();
    expect(typeof registry.registerPreservingOwner).toBe("function");
  });
});

// ── [R115 COUNTEREXAMPLE] THE OWNER THE CALLER WAS AUTHORIZED AGAINST ───────────────────────────────
//
// R77 closed the WRITER's window: the team is resolved where the write happens. The AUTHORIZER's window is
// the same shape one frame out — the route reads `teamOfEntity` to gate and the store re-reads it to write —
// and R77's own case above is the proof, read the other way round: it ASSERTS that the successor lands under
// the team the entity has now, which is exactly what a caller authorized against the old team must not be
// allowed to cause.
//
//     the current owner was preserved   ≠   the caller was authorized against that current owner
//
// Seen RED without the precondition: the transfer case below registered 1.1.0 under team-b for a caller the
// gate had cleared only for team-a.
describe("[R115 COUNTEREXAMPLE] the effect asserts the owner its authorization was granted against", () => {
  it("REFUSES when the entity changed teams after the gate read it", () => {
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice", "team-a");
    // The gate saw team-a…
    const authorized = agents.teamOfVersion("acme", "a1", "1.0.0");
    expect(authorized).toBe("team-a");
    // …and the entity moved before the write.
    agents.moveToTeam("acme", "a1", "team-b");

    const landed = agents.registerPreservingOwner("acme", spec("1.1.0"), "alice", undefined, {
      expectedOwnerTeamId: authorized,
    });

    expect(landed, "an authorization for team-a wrote a team-b version").toBe("owner_moved");
    expect(agents.versions("acme", "a1"), "the refused write registered a version anyway").toEqual(["1.0.0"]);
  });

  it("ALLOWS the unchanged owner — the control that keeps the precondition from being a wall", () => {
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice", "team-a");
    const landed = agents.registerPreservingOwner("acme", spec("1.1.0"), "alice", undefined, {
      expectedOwnerTeamId: "team-a",
    });
    expect(landed).toBe("registered");
    expect(agents.teamOfVersion("acme", "a1", "1.1.0")).toBe("team-a");
  });

  // The other half of the same asymmetry: `ownerOf` falls back to `_shared`, the owner lookup does not. So a
  // candidate that exists only in `_shared` had NO local owner to preserve and its first workspace version
  // was born unowned — a private team's campaign minting a capability every other team can see and write.
  it("gives a candidate with no LOCAL owner the team that authorized the write", () => {
    const agents = store();
    agents.register("_shared", spec("1.0.0"), "platform"); // shared, unowned, no local version
    expect(agents.versions("acme", "a1"), "the fixture has no shared version to shadow").toEqual(["1.0.0"]);

    const landed = agents.registerPreservingOwner("acme", spec("1.1.0"), "alice", undefined, {
      expectedOwnerTeamId: undefined, // the gate authorized an entity with no local owner
      initialTeamId: "team-a", // …and the campaign that caused the write belongs to team-a
    });

    expect(landed).toBe("registered");
    expect(
      agents.teamOfVersion("acme", "a1", "1.1.0"),
      "a private team's campaign minted a capability owned by nobody",
    ).toBe("team-a");
  });

  // …and the expectation of "unowned" is a real claim, not an absence of one.
  it("REFUSES an unowned expectation when the entity has since acquired a team", () => {
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice"); // local, unowned
    agents.moveToTeam("acme", "a1", "team-b");
    const landed = agents.registerPreservingOwner("acme", spec("1.1.0"), "alice", undefined, {
      expectedOwnerTeamId: undefined,
      initialTeamId: "team-a",
    });
    expect(landed, "an authorization over an unowned entity wrote into a team").toBe("owner_moved");
  });
});

// ── [R119 COUNTEREXAMPLE] A NEW VERSION MAY NOT RE-FILE THE ENTITY ──────────────────────────────────
//
// The wave above closed the window inside `registerPreservingOwner`. The ORDINARY `register` — the call every
// explicit-version create door makes — still wrote whatever team the caller named, and ownership is read off
// the newest version. So the takeover needed no race at all:
//
//     team-a owns helper@1.0.0 · a team-b member registers helper@2.0.0
//     → teamOfEntity(helper) = team-b · team-a can no longer write their own agent
//
// Verified through the real `create_agent` MCP door before the fix: `isError: undefined`, owner `team-b`.
// arch-review 118 closed exactly this at the SAVE door and left the CREATE door beside it, which is the
// one-lane-only shape with the two lanes being two doors onto one registry.
//
// It is also the write that MADE the two ownership predicates disagree — the gate reads the newest version's
// team, `registerPreservingOwner` resolves the oldest live one that has a team, and only a split entity can
// tell them apart. Refusing the split is what keeps them one answer.
//
// Seen RED before the fix, all three:
//   "a member of another team took the entity over: expected 'team-b' to be 'team-a'"
//   "registering disowned the entity: expected undefined to be 'team-a'"
//   the refusal case did not throw at all.
describe("[R119 COUNTEREXAMPLE] register cannot move an entity between teams", () => {
  const store = () => new VersionedStore<AgentSpec>("agent");
  const spec = (version: string) => ({ id: "a1", version, instructions: "x" }) as unknown as AgentSpec;

  it("REFUSES a version declaring a DIFFERENT team, and writes nothing", () => {
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice", "team-a");

    expect(() => agents.register("acme", spec("2.0.0"), "mallory", "team-b")).toThrow(/belongs to another team/);

    expect(agents.ownVersions("acme", "a1"), "the refused register wrote a version anyway").toEqual(["1.0.0"]);
    expect(agents.teamOfVersion("acme", "a1", "1.0.0"), "a member of another team took the entity over").toBe("team-a");
  });

  it("PRESERVES the owner when the caller names no team — registering is not a way to disown", () => {
    // The quieter half of the same takeover: an unowned newest version makes the entity unowned, which is
    // writable by every team. Silence must not be able to say that.
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice", "team-a");

    agents.register("acme", spec("2.0.0"), "alice");

    expect(agents.teamOfVersion("acme", "a1", "2.0.0"), "registering disowned the entity").toBe("team-a");
  });

  it("ALLOWS the entity's own team, and still fills an unowned entity — the two controls", () => {
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice", "team-a");
    agents.register("acme", spec("2.0.0"), "alice", "team-a"); // the owning team's own release
    expect(agents.teamOfVersion("acme", "a1", "2.0.0")).toBe("team-a");

    const fresh = store();
    fresh.register("acme", spec("1.0.0"), "alice"); // born unowned
    fresh.register("acme", spec("2.0.0"), "alice", "team-a"); // …a team may still claim it
    expect(fresh.teamOfVersion("acme", "a1", "2.0.0"), "an unowned entity refused its first owner").toBe("team-a");
  });

  it("keeps the two ownership predicates ONE answer — no reachable split remains", () => {
    // `teamOfEntity` reads the newest version; `registerPreservingOwner` resolves the oldest live one with a
    // team. They can only differ over a split, and nothing can create one now.
    const agents = store();
    agents.register("acme", spec("1.0.0"), "alice", "team-a");
    agents.register("acme", spec("2.0.0"), "alice");
    const versions = agents.ownVersions("acme", "a1");
    const teams = new Set(versions.map((v) => agents.teamOfVersion("acme", "a1", v)));
    expect(teams.size, "an entity's live versions disagree about who owns it").toBe(1);
  });
});
