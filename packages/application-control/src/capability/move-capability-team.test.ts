import type { Principal } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { EmitPlatformEventInput, PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import {
  TEAM_TRANSFERABLE_CAPABILITIES,
  type TeamTransferableRegistry,
  moveCapabilityToTeam,
} from "./move-capability-team.js";

// A registry that models only what ownership transfer touches: which versions a tenant owns, and the team each
// one is under. Versions are keyed the way the real stores order them — ascending, so the last is the newest.
class FakeRegistry implements TeamTransferableRegistry {
  private owned = new Map<string, Map<string, string | undefined>>(); // "tenant id" → version → teamId

  seed(tenant: string, id: string, versions: Record<string, string | undefined>): void {
    this.owned.set(`${tenant} ${id}`, new Map(Object.entries(versions)));
  }
  teamsOf(tenant: string, id: string): Array<string | undefined> {
    return [...(this.owned.get(`${tenant} ${id}`)?.values() ?? [])];
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return [...(this.owned.get(`${tenant} ${id}`)?.keys() ?? [])];
  }
  async teamOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.owned.get(`${tenant} ${id}`)?.get(version);
  }
  async moveToTeam(tenant: string, id: string, teamId: string): Promise<void> {
    const versions = this.owned.get(`${tenant} ${id}`);
    if (!versions) throw new Error("moveToTeam called for an entity the tenant does not own");
    for (const version of versions.keys()) versions.set(version, teamId);
  }
}

function member(teams: string[]): Principal {
  return { subject: "alice", workspace: "acme", roles: ["member"], via: "oidc", teams };
}
function admin(teams: string[] = []): Principal {
  return { subject: "root", workspace: "acme", roles: ["admin"], via: "oidc", teams };
}

function collector(): { emitted: EmitPlatformEventInput[]; emitter: PlatformEventEmitter } {
  const emitted: EmitPlatformEventInput[] = [];
  return {
    emitted,
    emitter: {
      async emit(input) {
        emitted.push(input);
        return undefined;
      },
    },
  };
}

const dataset = TEAM_TRANSFERABLE_CAPABILITIES.dataset;

describe("moveCapabilityToTeam — ownership is transferable, and both teams are authorized", () => {
  it("moves EVERY version of the entity, because ownership belongs to the thing and not to one release", async () => {
    const registry = new FakeRegistry();
    registry.seed("acme", "swe-mini", { "1.0.0": "team_eng", "1.1.0": "team_eng", "2.0.0": "team_eng" });

    const moved = await moveCapabilityToTeam({
      registry,
      capability: dataset,
      principal: member(["team_eng", "team_platform"]),
      id: "swe-mini",
      teamId: "team_platform",
    });

    expect(moved).toEqual({
      workspace: "acme",
      id: "swe-mini",
      teamId: "team_platform",
      previousTeamId: "team_eng",
    });
    expect(registry.teamsOf("acme", "swe-mini")).toEqual(["team_platform", "team_platform", "team_platform"]);
  });

  it("refuses a move to the team it is already on — an OK that changed nothing is indistinguishable from one that did", async () => {
    const registry = new FakeRegistry();
    registry.seed("acme", "swe-mini", { "1.0.0": "team_eng" });

    await expect(
      moveCapabilityToTeam({
        registry,
        capability: dataset,
        principal: member(["team_eng"]),
        id: "swe-mini",
        teamId: "team_eng",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("answers 404 for an id this workspace does not own (a _shared benchmark or another workspace's)", async () => {
    await expect(
      moveCapabilityToTeam({
        registry: new FakeRegistry(),
        capability: dataset,
        principal: member(["team_eng"]),
        id: "terminal-bench",
        teamId: "team_eng",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses when the caller is not on the SOURCE team — moving it out would be a way to take it", async () => {
    const registry = new FakeRegistry();
    registry.seed("acme", "swe-mini", { "1.0.0": "team_eng" });

    await expect(
      moveCapabilityToTeam({
        registry,
        capability: dataset,
        principal: member(["team_platform"]),
        id: "swe-mini",
        teamId: "team_platform",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(registry.teamsOf("acme", "swe-mini")).toEqual(["team_eng"]); // nothing moved
  });

  it("refuses when the caller is not on the DESTINATION team — you cannot push work into other teams' hands", async () => {
    const registry = new FakeRegistry();
    registry.seed("acme", "swe-mini", { "1.0.0": "team_eng" });

    await expect(
      moveCapabilityToTeam({
        registry,
        capability: dataset,
        principal: member(["team_eng"]),
        id: "swe-mini",
        teamId: "team_secret",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(registry.teamsOf("acme", "swe-mini")).toEqual(["team_eng"]);
  });

  it("lets an admin move between teams they are on neither of — an admin governs every team", async () => {
    const registry = new FakeRegistry();
    registry.seed("acme", "swe-mini", { "1.0.0": "team_eng" });

    await moveCapabilityToTeam({
      registry,
      capability: dataset,
      principal: admin(),
      id: "swe-mini",
      teamId: "team_platform",
    });

    expect(registry.teamsOf("acme", "swe-mini")).toEqual(["team_platform"]);
  });

  it("an UNOWNED entity has no source to authorize — the workspace's own things are anyone's to file", async () => {
    const registry = new FakeRegistry();
    registry.seed("acme", "legacy", { "1.0.0": undefined });

    const moved = await moveCapabilityToTeam({
      registry,
      capability: dataset,
      principal: member(["team_eng"]),
      id: "legacy",
      teamId: "team_eng",
    });

    expect(moved.previousTeamId).toBeUndefined();
    expect(registry.teamsOf("acme", "legacy")).toEqual(["team_eng"]);
  });

  it("emits the moved fact with both teams, stamped with the agent that acted (loop guard #1)", async () => {
    const registry = new FakeRegistry();
    registry.seed("acme", "swe-mini", { "1.0.0": "team_eng" });
    const { emitted, emitter } = collector();

    await moveCapabilityToTeam({
      registry,
      capability: dataset,
      principal: member(["team_eng", "team_platform"]),
      id: "swe-mini",
      teamId: "team_platform",
      events: emitter,
      agent: { agentId: "ag_1", conversationId: "cv_1" },
    });

    expect(emitted).toEqual([
      {
        workspace: "acme",
        kind: "dataset.moved",
        subject: { type: "dataset", id: "swe-mini" },
        actor: "alice",
        payload: { id: "swe-mini", to: "team_platform", from: "team_eng" },
        causedBy: "agent:ag_1:cv_1",
        message: "dataset swe-mini moved to team team_platform",
      },
    ]);
  });
});
