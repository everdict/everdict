import type { TeamRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Team, normalizeTeamKey } from "./team.js";

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-08-01T00:00:00.000Z";

function newTeam(overrides: Partial<Parameters<typeof Team.newTeam>[0]> = {}): TeamRecord {
  return Team.newTeam({
    id: "team-1",
    tenant: "acme",
    key: "ENG",
    name: "Engineering",
    isDefault: true,
    createdBy: "dana",
    now: NOW,
    ...overrides,
  });
}

describe("Team — the tracker's grouping layer", () => {
  it("normalizes the key to uppercase so a lowercase entry still renders ENG-1", () => {
    expect(newTeam({ key: "eng" }).key).toBe("ENG");
    expect(normalizeTeamKey("  ops ")).toBe("OPS");
  });

  it("rejects a key that is not 2-6 uppercase alphanumerics starting with a letter", () => {
    for (const key of ["E", "TOOLONGKEY", "1ENG", "EN-G", ""]) expect(() => newTeam({ key })).toThrow(BadRequestError);
  });

  it("starts with an empty issue counter and records its creation in the durable history", () => {
    const team = newTeam();
    expect(team.issueCounter).toBe(0);
    expect(team.history).toEqual([{ at: NOW, by: "dana", event: "created", detail: { key: "ENG", isDefault: true } }]);
  });

  it("announces creation as a team.created fact", () => {
    const [fact] = Team.creationFacts(newTeam());
    expect(fact?.kind).toBe("team.created");
    expect(fact?.subject).toEqual({ type: "team", id: "team-1" });
    expect(fact?.payload).toEqual({ key: "ENG", isDefault: true });
  });
});

describe("Team.allocateIssueNumber — the identifier sequence", () => {
  it("hands out the next number together with the patch that consumes it", () => {
    const allocation = Team.from(newTeam()).allocateIssueNumber(LATER);
    expect(allocation.number).toBe(1);
    expect(allocation.identifier).toBe("ENG-1");
    expect(allocation.patch.issueCounter).toBe(1);
  });

  it("continues from the stored counter rather than re-deriving it", () => {
    const allocation = Team.from({ ...newTeam(), issueCounter: 41 }).allocateIssueNumber(LATER);
    expect(allocation.number).toBe(42);
    expect(allocation.identifier).toBe("ENG-42");
  });
});

describe("Team.update — content editing, no facts", () => {
  it("renames without emitting a fact, because a rename is not lifecycle news", () => {
    const transition = Team.from(newTeam()).update({ name: "Platform" }, "dana", LATER);
    expect(transition.patch.name).toBe("Platform");
    expect(transition.facts).toEqual([]);
  });

  it("refuses a no-op edit", () => {
    expect(() => Team.from(newTeam()).update({ name: "Engineering" }, "dana", LATER)).toThrow(BadRequestError);
  });

  it("has no way to change the key — it is baked into every identifier already minted", () => {
    const transition = Team.from(newTeam()).update({ name: "Platform" }, "dana", LATER);
    expect(transition.patch).not.toHaveProperty("key");
  });
});

describe("Team default flag — exactly one per workspace", () => {
  it("refuses to promote a team that is already the default", () => {
    expect(() => Team.from(newTeam()).promoteToDefault("dana", LATER)).toThrow(ConflictError);
  });

  it("refuses to demote a team that is not the default", () => {
    expect(() => Team.from(newTeam({ isDefault: false })).demoteFromDefault(LATER)).toThrow(ConflictError);
  });

  it("promotes a non-default team and records the flag change", () => {
    const transition = Team.from(newTeam({ isDefault: false })).promoteToDefault("dana", LATER);
    expect(transition.patch.isDefault).toBe(true);
    expect(transition.patch.history?.at(-1)?.detail).toEqual({ changed: ["isDefault"], isDefault: true });
  });
});

describe("Team.assertDeletable — a workspace keeps at least one team", () => {
  it("refuses to delete the default team", () => {
    expect(() => Team.from(newTeam()).assertDeletable(2, 0, 0)).toThrow(ConflictError);
  });

  it("refuses to delete the last remaining team", () => {
    expect(() => Team.from(newTeam({ isDefault: false })).assertDeletable(0, 0, 0)).toThrow(ConflictError);
  });

  it("refuses to delete a team that still holds issues, naming the count", () => {
    expect(() => Team.from(newTeam({ isDefault: false })).assertDeletable(1, 3, 0)).toThrow(/3 issue/);
  });

  it("refuses to delete a team that still has sub-teams, naming the count", () => {
    expect(() => Team.from(newTeam({ isDefault: false })).assertDeletable(1, 0, 2)).toThrow(/2 sub-team/);
  });

  it("allows deleting a non-default, empty, childless team while another remains", () => {
    expect(() => Team.from(newTeam({ isDefault: false })).assertDeletable(1, 0, 0)).not.toThrow();
  });
});

describe("Team roster — membership changes are facts", () => {
  it("emits team.member_added and appends the durable history entry", () => {
    const transition = Team.from(newTeam()).memberAdded("alice", "dana", LATER);
    expect(transition.facts[0]?.kind).toBe("team.member_added");
    expect(transition.facts[0]?.payload).toEqual({ member: "alice", key: "ENG" });
    expect(transition.patch.history?.at(-1)).toEqual({
      at: LATER,
      by: "dana",
      event: "member_added",
      detail: { subject: "alice" },
    });
  });

  it("emits team.member_removed on the way out", () => {
    const transition = Team.from(newTeam()).memberRemoved("alice", "dana", LATER);
    expect(transition.facts[0]?.kind).toBe("team.member_removed");
    expect(transition.patch.history?.at(-1)?.event).toBe("member_removed");
  });
});
