import type { AgentSpec } from "@everdict/contracts";
import { PgAgentRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-187: the adoption's registry write asserts the owner its
// authorization was granted against, on real Postgres (arch-review 115).
//
// arch-review 77 closed the window inside the WRITER by resolving the owner where the write happens. The
// AUTHORIZER's window is the same shape one frame out — the route reads `teamOfEntity` to gate and the store
// re-reads it to write — so a transfer landing between them files the successor under a team the caller may
// not write to. Owner preservation succeeded; authorization is what did not.
//
// ⚠️ ONLY REAL POSTGRES CAN CERTIFY THIS. The decision lives in the INSERT's own `WHERE NOT (...)`, over a
// scalar subquery that reads the entity's current owner — SQL a fake client cannot evaluate and an in-memory
// twin re-implements rather than executes (rule `testing`: a decision that lives in the adapter is certified
// against the adapter). The unit suite pins the in-memory shape; this pins the statement.
//
// ⚠️ AND IT CAUGHT THE FIXTURE FIRST. The first version of this drive constructed `PgVersionedStore` with
// `hasTeamId`/`hasCreatedBy` — names the options object does not have — so every write silently produced a
// NULL team and all three cases "passed" the wrong way. A probe that misconfigures the subject measures the
// subject's default, not the subject.
describe.skipIf(!TRUST_PG_ENABLED)(
  "TRUST-187 — a successor is refused when its entity changed teams after the gate read it",
  () => {
    let pg: TrustPg;
    let agents: PgAgentRegistry;

    beforeAll(async () => {
      pg = await openTrustPg();
      agents = new PgAgentRegistry(pg.client);
    });
    afterAll(async () => pg?.close());

    const spec = (id: string, version: string): AgentSpec =>
      ({ id, version, instructions: "x", mcpServers: [], capabilities: [] }) as unknown as AgentSpec;

    it("REFUSES the write, and writes nothing, when the owner moved between the gate and the effect", async () => {
      const id = trustId("agt");
      await agents.register("trust", spec(id, "1.0.0"), "alice", "team-a");
      // The gate saw team-a. Then the entity moves — a real transfer, not a simulated one.
      await pg.client.query("UPDATE everdict_agents SET team_id = 'team-b' WHERE tenant = $1 AND id = $2", [
        "trust",
        id,
      ]);

      const landed = await agents.registerPreservingOwner("trust", spec(id, "1.1.0"), "alice", undefined, {
        expectedOwnerTeamId: "team-a",
      });

      expect(landed, "an authorization for team-a wrote a team-b version").toBe("owner_moved");
      // The WORLD, not the return value: a refusal after the row exists is not a refusal (rule `protocol`).
      expect((await agents.ownVersions("trust", id)).sort(), "the refused write registered a version anyway").toEqual([
        "1.0.0",
      ]);
    });

    it("ALLOWS the unchanged owner and keeps the entity's team — the control", async () => {
      const id = trustId("agt");
      await agents.register("trust", spec(id, "1.0.0"), "alice", "team-a");

      const landed = await agents.registerPreservingOwner("trust", spec(id, "1.1.0"), "alice", undefined, {
        expectedOwnerTeamId: "team-a",
      });

      expect(landed, "the entity's own team was refused its successor").toBe("registered");
      expect(await agents.teamOfVersion("trust", id, "1.1.0")).toBe("team-a");
    });

    it("gives an entity with no LOCAL version the team that authorized the write", async () => {
      // `ownerOf` falls back to `_shared`; the owner subquery is tenant-local. So a candidate that exists only
      // as a shared capability had nothing to preserve and its first workspace version was born UNOWNED —
      // a private team's campaign minting something every other team can see and write.
      const id = trustId("agt");
      expect(await agents.ownVersions("trust", id), "the fixture already has a local version").toEqual([]);

      const landed = await agents.registerPreservingOwner("trust", spec(id, "1.0.1"), "alice", undefined, {
        expectedOwnerTeamId: undefined, // the gate authorized an entity with no local owner
        initialTeamId: "team-a", // …and the campaign that caused the write belongs to team-a
      });

      expect(landed).toBe("registered");
      expect(
        await agents.teamOfVersion("trust", id, "1.0.1"),
        "a private team's campaign minted a capability owned by nobody",
      ).toBe("team-a");
    });

    it("treats an expectation of UNOWNED as a claim, not as an absent one", async () => {
      const id = trustId("agt");
      await agents.register("trust", spec(id, "1.0.0"), "alice"); // local, unowned
      await pg.client.query("UPDATE everdict_agents SET team_id = 'team-b' WHERE tenant = $1 AND id = $2", [
        "trust",
        id,
      ]);

      const landed = await agents.registerPreservingOwner("trust", spec(id, "1.1.0"), "alice", undefined, {
        expectedOwnerTeamId: undefined,
        initialTeamId: "team-a",
      });

      expect(landed, "an authorization over an unowned entity wrote into a team").toBe("owner_moved");
      expect(await agents.ownVersions("trust", id)).toEqual(["1.0.0"]);
    });

    it("leaves the lanes that pass no authority exactly as they were", async () => {
      // The agent bump and the harness re-pin authorize the entity itself, so they carry no expectation —
      // and must keep preserving the owner without ever answering `owner_moved`.
      const id = trustId("agt");
      await agents.register("trust", spec(id, "1.0.0"), "alice", "team-a");
      await pg.client.query("UPDATE everdict_agents SET team_id = 'team-b' WHERE tenant = $1 AND id = $2", [
        "trust",
        id,
      ]);

      const landed = await agents.registerPreservingOwner("trust", spec(id, "1.1.0"), "alice");

      expect(landed).toBe("registered");
      expect(
        await agents.teamOfVersion("trust", id, "1.1.0"),
        "a lane with no expectation stopped preserving the owner",
      ).toBe("team-b");
    });
  },
);

// ── [R120] THE EXACT-VERSION LANE ASKS THE SAME QUESTION (arch-review 120) ──────────────────────────
//
// TRUST-187 above pins the INSERT: a version that does not exist yet is refused when the entity moved. The
// commonest adoption is the other one — the proof approved an EXACT version, and by the time it is spent
// that version already exists. `registerReturning`'s exact-row branch returned "registered" without
// consulting `authority` at all, under a comment saying "nothing was written, and nothing about ownership
// was contradicted". Both halves were false: that branch REVIVES a tombstone, FILLS a team and FILLS an
// origin, and the caller was authorized against an owner that may have moved.
//
//     same identity   ≠   authority still valid
//
// The in-memory twin has always asked first, so every unit test of this refusal was green while the adapter
// production runs waved the case through — the adapter-divergence law, with the divergence on the permissive
// side.
//
// ⚠️ ONLY REAL POSTGRES CAN CERTIFY IT. The decision is now one data-modifying CTE: an `authorized` arm read
// against the same snapshot as the revive and the two fills, so either all of them see an authorized world
// or none of them runs. A fake client evaluates none of that.
//
// Seen RED before the fix: "an authorization for team-a revived a team-b version: expected 'registered' to
// be 'owner_moved'".
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-189 — the exact version already exists, and the owner moved", () => {
  let pg: TrustPg;
  let agents: PgAgentRegistry;

  beforeAll(async () => {
    pg = await openTrustPg();
    agents = new PgAgentRegistry(pg.client);
  });
  afterAll(async () => pg?.close());

  const spec = (id: string, version: string): AgentSpec =>
    ({ id, version, instructions: "x", mcpServers: [], capabilities: [] }) as unknown as AgentSpec;

  it("REFUSES re-presenting the exact approved version after the entity changed teams", async () => {
    const id = trustId("agt");
    await agents.register("trust", spec(id, "1.0.0"), "alice", "team-a");
    await agents.register("trust", spec(id, "1.1.0"), "alice", "team-a"); // the version the proof approved
    await pg.client.query("UPDATE everdict_agents SET team_id = 'team-b' WHERE tenant = $1 AND id = $2", ["trust", id]);

    const landed = await agents.registerPreservingOwner("trust", spec(id, "1.1.0"), "alice", undefined, {
      expectedOwnerTeamId: "team-a",
    });

    expect(landed, "an authorization for team-a spent itself on a team-b version").toBe("owner_moved");
    expect(await agents.teamOfVersion("trust", id, "1.1.0"), "the refused call moved the version").toBe("team-b");
  });

  it("REFUSES reviving a tombstoned exact version under a team the caller cannot write to", async () => {
    // The loudest form: the same call does not merely record metadata, it brings a deleted version BACK.
    const id = trustId("agt");
    await agents.register("trust", spec(id, "1.0.0"), "alice", "team-a");
    await agents.register("trust", spec(id, "1.1.0"), "alice", "team-a");
    await agents.softDelete("trust", id, "1.1.0");
    await pg.client.query("UPDATE everdict_agents SET team_id = 'team-b' WHERE tenant = $1 AND id = $2", ["trust", id]);

    const landed = await agents.registerPreservingOwner("trust", spec(id, "1.1.0"), "alice", undefined, {
      expectedOwnerTeamId: "team-a",
    });

    expect(landed, "an authorization for team-a revived a team-b version").toBe("owner_moved");
    expect(
      (await agents.ownVersions("trust", id)).includes("1.1.0"),
      "the refused call revived the tombstone anyway",
    ).toBe(false);
  });

  it("gives an exact UNOWNED version the team that authorized the write", async () => {
    // The other half of `initialTeamId`: the version exists and belongs to nobody, so a private team's
    // campaign adopting it must not leave it workspace-unowned — the state every team can write.
    const id = trustId("agt");
    await agents.register("trust", spec(id, "1.0.0"), "alice"); // local, unowned
    expect(await agents.teamOfVersion("trust", id, "1.0.0")).toBeUndefined();

    const landed = await agents.registerPreservingOwner("trust", spec(id, "1.0.0"), "alice", undefined, {
      expectedOwnerTeamId: undefined,
      initialTeamId: "team-a",
    });

    expect(landed).toBe("registered");
    expect(
      await agents.teamOfVersion("trust", id, "1.0.0"),
      "a private team's campaign adopted an exact version and left it owned by nobody",
    ).toBe("team-a");
  });

  it("ALLOWS the unchanged owner — the control, and it must stay idempotent", async () => {
    const id = trustId("agt");
    await agents.register("trust", spec(id, "1.0.0"), "alice", "team-a");

    const landed = await agents.registerPreservingOwner("trust", spec(id, "1.0.0"), "alice", undefined, {
      expectedOwnerTeamId: "team-a",
    });

    expect(landed, "the entity's own team was refused its own version").toBe("registered");
    expect(await agents.ownVersions("trust", id)).toEqual(["1.0.0"]);
  });
});
