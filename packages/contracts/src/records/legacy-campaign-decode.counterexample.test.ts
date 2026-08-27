import { describe, expect, it } from "vitest";
import { CampaignFrameSchema, EvolutionCampaignRecordSchema, StoredCampaignFrameSchema } from "./evolution-campaign.js";

// ── A CREATION RULE APPLIED AT DECODE TIME IS A DATA OUTAGE (arch-review 72 P1) ─────────────────────
//
// arch-review 71 made the frame require at least two held-out scenarios, which is right: a campaign that
// cannot separate training from held-out has no adoption evidence. The mistake was using ONE schema for two
// different questions.
//
//     what may be CREATED       >= 2 held out, unique ids
//     what may be READ BACK     whatever was legitimately stored before that rule existed
//
// `EvolutionCampaignRecordSchema` embeds the frame and `rowToRecord` parses stored rows through it, so a
// campaign written under the previous schema stopped decoding. `list()` is `rows.map(rowToRecord)` — ONE
// legacy row takes down the whole workspace's campaign list. A policy change became an availability
// regression, and it shipped.
//
// This repository already knows the shape: `docs/migration/` is expand → deploy → contract. A constraint
// tightened on the WRITE path is an expand; tightening the READ path in the same change is the contract, and
// doing both at once is what breaks rows that were valid when they were written.
//
// A legacy campaign stays readable and listable and is NOT adoption evidence — the gate already refuses a
// round with no `heldOut` block, so nothing here weakens the decision. What is restored is the ability to
// read the row at all. Held-out flags are NOT backfilled: guessing which scenarios were held out would
// manufacture the very evidence the rule exists to require.
//
// Seen RED before the schemas were split, observed:
//   a campaign stored before the rule existed became unreadable: expected false to be true

const legacyFrame = {
  subject: { type: "agent", id: "a1", baselineVersion: "1.0.0" },
  // Exactly what the previous schema accepted: one scenario, held-out defaulting false.
  scenarios: [{ id: "case-1", heldOut: false }],
  judges: [],
  trialsPerCase: 3,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
};

const legacyRow = {
  id: "camp-old",
  tenant: "acme",
  issueId: "iss-1",
  frame: legacyFrame,
  frameDigest: "sha256:x",
  rounds: [],
  state: "open",
  createdBy: "alice",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("[R72 COUNTEREXAMPLE] a campaign stored before the held-out rule is still readable", () => {
  it("DECODES a legacy record", () => {
    const parsed = EvolutionCampaignRecordSchema.safeParse(legacyRow);
    expect(parsed.success, "a campaign stored before the rule existed became unreadable").toBe(true);
  });

  it("DECODES a legacy frame on its own, through the storage schema", () => {
    expect(StoredCampaignFrameSchema.safeParse(legacyFrame).success).toBe(true);
  });

  it("still REFUSES to create one", () => {
    // The rule itself is untouched: what changed is where it applies. A new campaign with no held-out
    // evidence is still refused at the door.
    const created = CampaignFrameSchema.safeParse(legacyFrame);
    expect(created.success, "the creation rule was weakened to fix the read path").toBe(false);
  });

  it("still refuses duplicate ids at creation", () => {
    const dupes = {
      ...legacyFrame,
      scenarios: [
        { id: "s", heldOut: true },
        { id: "s", heldOut: true },
      ],
    };
    expect(CampaignFrameSchema.safeParse(dupes).success).toBe(false);
  });

  it("does NOT backfill held-out flags onto a legacy frame", () => {
    // The tempting repair, and the wrong one: inventing held-out flags would manufacture exactly the
    // evidence the rule exists to require. A legacy campaign reads back as what it was.
    const parsed = StoredCampaignFrameSchema.parse(legacyFrame);
    expect(
      parsed.scenarios.every((s) => s.heldOut === false),
      "held-out was guessed on the way in",
    ).toBe(true);
  });
});
