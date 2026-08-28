import { ForbiddenError } from "@everdict/contracts";
import type { Principal } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { type VersionTaggable, setVersionTags } from "./version-tag-service.js";

// ── [R119 COUNTEREXAMPLE] RETAGGING A VERSION IS A WRITE TO SOMEBODY'S ASSET ────────────────────────
//
// `setVersionTags` is the shared core behind TWELVE doors — dataset · harness · judge · runtime · rubric,
// on both transports — and it called `authorize(principal, action)` with no resource scope. The documented
// invariant is the opposite (docs/auth.md §"The team axis", docs/tracker.md): writing an EVAL ASSET owned
// by a team you are not on is refused; only the tracker's own records are exempt, and by name.
//
// Version tags are how a release is labelled and found (`stable`, `pinned-for-Q3`). Retagging another
// team's version is editing their asset, and every door here reused that team's own content-mutation
// action — the right action, asked without saying about WHAT.
//
// One core, so one fix closes twelve lanes; and the owner readers are REQUIRED on the port rather than
// optional, because an optional one is indistinguishable from a registry that chose not to answer
// (rule `protocol`, "an optional dependency with no producer is a plan").
//
// Seen RED before the fix: "another team's version was retagged: expected [Function] to throw an error".

const OWNED_BY_A: VersionTaggable = {
  async setVersionTags() {
    written.push("wrote");
  },
  async ownVersions() {
    return ["1.0.0", "1.1.0"];
  },
  // Ownership is read off the entity, which is its NEWEST own version — the same answer every other write
  // gate uses, so a tag write cannot disagree with a save about whose asset this is. Every version answers
  // the same here because a split is exactly what the registry refuses to create (arch-review 119).
  async teamOfVersion() {
    return "team-a";
  },
};

let written: string[] = [];

const member = (teams: string[]): Principal =>
  ({ subject: "u", workspace: "acme", roles: ["member"], via: "oidc", teams }) as unknown as Principal;

describe("[R119 COUNTEREXAMPLE] setVersionTags authorizes against the entity's team", () => {
  it("REFUSES a member of another team, and writes nothing", async () => {
    written = [];
    await expect(
      setVersionTags(OWNED_BY_A, member(["team-b"]), "datasets:write", "swe-mini", "1.0.0", ["stable"]),
      "another team's version was retagged",
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(written, "the refused write reached the registry anyway").toEqual([]);
  });

  it("ALLOWS the owning team — the control", async () => {
    written = [];
    const out = await setVersionTags(OWNED_BY_A, member(["team-a"]), "datasets:write", "swe-mini", "1.0.0", ["stable"]);
    expect(out.tags).toEqual(["stable"]);
    expect(written).toEqual(["wrote"]);
  });

  it("ALLOWS an UNOWNED entity — unowned is the workspace's, never nobody's", async () => {
    written = [];
    const unowned: VersionTaggable = {
      ...OWNED_BY_A,
      async teamOfVersion() {
        return undefined;
      },
    };
    await setVersionTags(unowned, member(["team-b"]), "datasets:write", "swe-mini", "1.0.0", ["x"]);
    expect(written).toEqual(["wrote"]);
  });

  it("reads the owner off the NEWEST version, not the one being tagged", async () => {
    // A version's own team is not the question — ownership belongs to the entity. Tagging an OLD version of
    // a moved entity must be judged against where the entity is now, or a transfer would leave a back door
    // open on every version that predates it.
    written = [];
    const moved: VersionTaggable = {
      ...OWNED_BY_A,
      async teamOfVersion(_t, _i, version) {
        return version === "1.1.0" ? "team-b" : "team-a"; // the entity moved; 1.0.0 predates the move
      },
    };
    await setVersionTags(moved, member(["team-b"]), "datasets:write", "swe-mini", "1.0.0", ["x"]);
    expect(written, "tagging an old version was judged against a team that no longer owns the entity").toEqual([
      "wrote",
    ]);
  });
});
