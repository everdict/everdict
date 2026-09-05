import { describe, expect, it } from "vitest";
import { CampaignService } from "./campaign-service.js";

// ── THE TWO POINTERS THAT HAD NO READER ──────────────────────────────────────────────────────────────
//
// `frame.continues` is validated at open by `assertChainIsHonest` — the predecessor must be settled, its
// budget spent, its adoption real — and then nothing carried what that predecessor LEARNED into the
// successor's brief. `informedBy` never had a reader at all: a round names the campaigns whose findings
// shaped it and every consumer in the tree ignored the field.
//
// The brief is the artifact a delegate is handed. This drives the SERVICE, not the renderer, because the
// renderer's own counterexample cannot see that nothing calls it (rule `testing`: a counterexample for a
// protocol drives the production composition).
//
// RED before the change:
//   AssertionError: expected '{"goal":"Change harness…' to contain 'the tool budget'

const frame = {
  subject: { type: "harness" as const, id: "sbench", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "s1", heldOut: false },
    { id: "s2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  targets: ["s1"],
  observationPolicy: { allowDivergent: false },
};

const round = (seq: number, learned: string, informedBy: string[] = []) => ({
  seq,
  hypothesis: "h",
  informedBy,
  candidateVersion: `1.0.${seq}`,
  baselineScorecardId: "sc-base",
  candidateScorecardId: `sc-${seq}`,
  learned,
  verdict: {
    comparable: true,
    significantImprovements: 0,
    significantRegressions: 0,
    unverifiedAxes: [],
    confoundedAxes: [],
  },
  at: "2026-09-05T00:00:00.000Z",
  by: "agent:everdict",
});

// `unreadable` names ids whose READ DOES NOT HAPPEN, as distinct from ids the map simply does not hold. The
// port draws that line itself — `undefined` for a record this workspace does not have, a throw for a store
// that could not answer — and the fixture has to be able to produce both or the difference cannot be tested.
function service(records: Record<string, unknown>, unreadable: string[] = []) {
  return new CampaignService({
    store: {
      get: async (_t: string, id: string) => {
        if (unreadable.includes(id)) throw new Error(`connection terminated unexpectedly while reading ${id}`);
        return records[id];
      },
    },
    scorecards: { get: async () => undefined },
    issues: { get: async (_t: string, ref: string) => ({ id: ref, links: [] }) },
    datasets: { get: async () => ({ cases: [] }) },
    evidence: { stage: async () => undefined, get: async () => undefined },
    seedProvenance: { seedsOf: async () => [] },
    shape: { slotsOf: async () => [] },
    diffs: { diffSnapshot: async () => ({}) },
    operations: { create: async () => undefined, forCampaign: async () => undefined },
    changes: { pullRequestFiles: async () => ({ kind: "read" as const, value: [] }) },
    runs: { get: async () => undefined },
    newId: () => "camp-x",
    now: () => "2026-09-05T00:00:00.000Z",
  } as never);
}

describe("a chained campaign's brief carries what the walk before it established", () => {
  it("`continues` brings the predecessor's findings into the successor's brief", async () => {
    const svc = service({
      "camp-1": { id: "camp-1", tenant: "acme", frame, rounds: [round(1, "the tool budget was not the constraint")] },
      "camp-2": { id: "camp-2", tenant: "acme", frame: { ...frame, continues: "camp-1" }, rounds: [] },
    });
    const brief = await svc.roundBrief("acme", "camp-2");
    expect(JSON.stringify(brief)).toContain("the tool budget was not the constraint");
    expect(JSON.stringify(brief)).toContain("camp-1");
  });

  it("`informedBy` finally has a reader — a named campaign's findings ride along", async () => {
    const svc = service({
      "camp-9": { id: "camp-9", tenant: "acme", frame, rounds: [round(1, "recalc order is what the grader needs")] },
      "camp-2": {
        id: "camp-2",
        tenant: "acme",
        frame,
        rounds: [round(1, "this walk's own finding", ["camp-9"])],
      },
    });
    const brief = await svc.roundBrief("acme", "camp-2");
    expect(JSON.stringify(brief)).toContain("recalc order is what the grader needs");
  });

  it("A MISSING ANCESTOR IS LESS ADVICE, NOT A FAILED HANDOFF", async () => {
    // The chain's HONESTY is enforced at open, which is where a refusal belongs. Failing the brief because
    // one ancestor is unreadable would break the handoff over the least important part of it.
    const svc = service({
      "camp-2": { id: "camp-2", tenant: "acme", frame: { ...frame, continues: "gone" }, rounds: [] },
    });
    const brief = await svc.roundBrief("acme", "camp-2");
    expect(brief.goal).toContain("sbench");
  });

  it("AN UNREADABLE ANCESTOR IS NOT A MISSING ONE — the gap is stated, never swallowed", async () => {
    // RED before the fix, whose `.catch(() => undefined)` spelled a store outage exactly like a deleted
    // ancestor:
    //   AssertionError: expected '{"goal":"Change harness \'sbench\'…' to contain 'could not be read'
    //
    // The test above is right that a MISSING ancestor is less advice rather than a failed handoff. This is
    // the other half of that sentence: a read that did not happen is not an absence, and a delegate handed
    // an empty inheritance reads it as "the earlier walks established nothing worth carrying" — the one
    // reading that makes it spend the round re-deriving what a previous one already found (`protocol` L2).
    const svc = service(
      { "camp-2": { id: "camp-2", tenant: "acme", frame: { ...frame, continues: "camp-1" }, rounds: [] } },
      ["camp-1"],
    );
    const brief = await svc.roundBrief("acme", "camp-2");
    const rendered = JSON.stringify(brief);
    expect(rendered).toContain("could not be read");
    expect(rendered).toContain("camp-1");
    // …and it is a GAP, not a refusal: the brief is still handed over.
    expect(brief.goal).toContain("sbench");
  });

  it("and a genuinely absent ancestor still says nothing — the two do not collapse in the other direction", async () => {
    const svc = service({
      "camp-2": { id: "camp-2", tenant: "acme", frame: { ...frame, continues: "gone" }, rounds: [] },
    });
    const brief = await svc.roundBrief("acme", "camp-2");
    expect(JSON.stringify(brief)).not.toContain("could not be read");
  });

  it("a held-out id in an INHERITED finding is redacted, under this frame's held-out set", async () => {
    const svc = service({
      "camp-1": { id: "camp-1", tenant: "acme", frame, rounds: [round(1, "s2 is unwinnable as published")] },
      "camp-2": { id: "camp-2", tenant: "acme", frame: { ...frame, continues: "camp-1" }, rounds: [] },
    });
    const brief = await svc.roundBrief("acme", "camp-2");
    expect(JSON.stringify(brief)).not.toContain("s2");
    expect(JSON.stringify(brief)).toContain("held-out");
  });
});
