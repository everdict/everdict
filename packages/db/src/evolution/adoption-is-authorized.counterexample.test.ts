import type { CampaignClose, CampaignFrame, CampaignRound, EvolutionCampaignRecord } from "@everdict/contracts";
import { adoptionProofOf, campaignAdoption, contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryEvolutionCampaignStore } from "./campaign-store.js";

// ── A CAMPAIGN CLOSED "ADOPTED" AND NOTHING ADOPTED ANYTHING (arch-review 71 P0-evolution) ──────────
//
// `settle` computed the gate's answer, wrote `adopted` with the version and the proving scorecard, and
// executed no effect. The MCP tool told the caller to go run `save_agent` or `register_harness` afterwards —
// generic authoring APIs with no campaign id, no frame digest, no round sequence, no candidate digest and no
// gate answer. Four states were reachable and all of them silent:
//
//     settle → crash             adopted, and no capability anywhere
//     save with no gate          a capability with no adoption authority
//     C1 evaluated, C2 saved     one version label over two different specs
//     adopted, issue unresolved  the decision and its intent came apart
//
//     CampaignGateAnswer exists   ≠   a registry effect consumed it
//
// The authorization is a durable OPERATION now, written in the same statement as the close, and a registry
// write spends it by presenting the exact proof. `decided` is the state a crash lands in — visible,
// addressable, re-drivable — where a campaign that merely said `adopted` was none of those.
//
// Seen RED before the operation existed, observed:
//   an adopted campaign authorized nothing anybody could spend: expected undefined to be defined

const FRAME = {
  subject: { type: "agent", id: "a1", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "h1", heldOut: true },
    { id: "h2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 3,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 }, // frozen: the level, and the family it is corrected over
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  observationPolicy: { allowDivergent: false },
} as unknown as CampaignFrame;

const round = (specDigest?: string): CampaignRound =>
  ({
    seq: 1,
    hypothesis: "structure over phrasing",
    candidateVersion: "1.1.0",
    baselineScorecardId: "sc-base",
    candidateScorecardId: "sc-cand",
    at: "2026-08-27T00:00:00.000Z",
    verdict: {
      comparable: true,
      significantImprovements: 1,
      significantRegressions: 0,
      heldOut: { improvements: 1, regressions: 0 },
      observations: { divergent: 0, unclear: 0 },
      unverifiedAxes: [],
      confoundedAxes: [],
      ...(specDigest !== undefined ? { candidateSpecDigest: specDigest } : {}),
    },
  }) as unknown as CampaignRound;

const record = (rounds: CampaignRound[]): EvolutionCampaignRecord =>
  ({
    id: "camp-1",
    tenant: "acme",
    issueId: "iss-9",
    frame: FRAME,
    frameDigest: contentDigest(FRAME),
    rounds,
    state: "open",
    createdBy: "alice",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  }) as unknown as EvolutionCampaignRecord;

const closeDoc = (version: string): CampaignClose =>
  ({
    outcome: { kind: "adopted", version, provingScorecardId: "sc-cand", waivedAxes: [] },
    at: "2026-08-27T01:00:00.000Z",
    by: "alice",
  }) as unknown as CampaignClose;

// The whole settle, as the service performs it: gate → proof → close carrying the authorization.
const settled = async (specDigest?: string) => {
  const store = new InMemoryEvolutionCampaignStore();
  const rec = record([round(specDigest)]);
  await store.create(rec);
  const answer = campaignAdoption(rec.frame, rec.rounds);
  const proof = adoptionProofOf(answer, rec, rec.rounds);
  expect(proof, "the gate authorized nothing, so this fixture measures nothing").toBeDefined();
  if (proof === undefined) throw new Error("unreachable");
  await store.close("acme", rec.id, "adopted", closeDoc("1.1.0"), 1, undefined, {
    operationId: `adopt/acme/${rec.id}`,
    tenant: "acme",
    proof,
    state: "decided",
    createdAt: "2026-08-27T01:00:00.000Z",
    updatedAt: "2026-08-27T01:00:00.000Z",
  });
  return { store, proof };
};

describe("[R71 COUNTEREXAMPLE] an adopted campaign leaves an authorization somebody must spend", () => {
  it("writes a DECIDED operation with the close — the state a crash lands in", async () => {
    const { store } = await settled("sha256:c1");

    const op = await store.forCampaign("acme", "camp-1");
    expect(op, "an adopted campaign authorized nothing anybody could spend").toBeDefined();
    expect(op?.state, "the authorization was born already spent").toBe("decided");
    // It names the bytes, the exam and the trace position — everything an effect must be held to.
    expect(op?.proof.candidate.specDigest).toBe("sha256:c1");
    expect(op?.proof.frameDigest).toBe(contentDigest(FRAME));
    expect(op?.proof.roundSeq).toBe(1);
    expect(op?.proof.issueId, "the decision and its intent came apart").toBe("iss-9");
  });

  it("SPENDS it exactly once", async () => {
    // Two registry writes presenting one authorization must not both land: the second is told it is a
    // convergence, not granted a second adoption.
    const { store, proof } = await settled("sha256:c1");
    const digest = contentDigest(proof);

    expect(await store.markRegistered("acme", "camp-1", digest, "1.1.0")).toBe("registered");
    expect(await store.markRegistered("acme", "camp-1", digest, "1.1.0")).toBe("already_registered");
    expect((await store.forCampaign("acme", "camp-1"))?.registeredVersion).toBe("1.1.0");
  });

  it("DISCHARGES the intent only from `registered`, and only once (arch-review 73)", async () => {
    // `completed` had no writer for two waves — the fourth of arch-review 71's four silent states. The
    // store's conditional write is the authority the E1 watch rests on: an adoption whose registry write
    // never landed has no intent to settle, and a redelivery converges rather than discharging twice.
    const { store, proof } = await settled("sha256:c1");
    const digest = contentDigest(proof);

    // Still `decided` — nothing was registered, so there is nothing to have settled.
    expect(
      await store.markCompleted("acme", "camp-1", digest),
      "an unspent authorization was marked as having settled its intent",
    ).toBe("not_registered");

    expect(await store.markRegistered("acme", "camp-1", digest, "1.1.0")).toBe("registered");
    expect(await store.markCompleted("acme", "camp-1", digest)).toBe("completed");
    // At-least-once redelivery: convergence, not a second discharge and not an error.
    expect(await store.markCompleted("acme", "camp-1", digest)).toBe("already_completed");
    expect((await store.forCampaign("acme", "camp-1"))?.state).toBe("completed");
  });

  it("EMITS a fact on each lifecycle transition, riding the same write (arch-review 83)", async () => {
    // `campaign.closed` says the gate decided; it does not say the decision took effect. Three waves shipped
    // `decided → registered → completed` with no facts at all, so the activity feed showed a campaign
    // closing and never showed the capability arriving — rule `events` is explicit that a state transition
    // ships its fact in the same PR, and "a version registered" is its own example.
    //
    // Seen RED before the facts existed, observed:
    //   the spend emitted no fact: expected [] to have a length of 1
    const { store, proof } = await settled("sha256:c1");
    const digest = contentDigest(proof);
    const before = store.outbox().length;

    expect(
      await store.markRegistered("acme", "camp-1", digest, "1.1.0", [
        {
          id: "ev-r",
          tenant: "acme",
          kind: "campaign.adoption_registered",
          subject: { type: "campaign", id: "camp-1" },
          actor: "alice",
          payload: {},
          at: "t",
        },
      ] as never),
    ).toBe("registered");
    expect(store.outbox().length - before, "the spend emitted no fact").toBe(1);

    expect(
      await store.markCompleted("acme", "camp-1", digest, [
        {
          id: "ev-c",
          tenant: "acme",
          kind: "campaign.adoption_completed",
          subject: { type: "campaign", id: "camp-1" },
          actor: "watch",
          payload: {},
          at: "t",
        },
      ] as never),
    ).toBe("completed");
    expect(store.outbox().length - before, "the discharge emitted no fact").toBe(2);

    // …and a REFUSED transition leaves none: a fact for a spend that lost its race must not exist.
    const refused = store.outbox().length;
    expect(
      await store.markRegistered("acme", "camp-1", digest, "1.1.0", [
        {
          id: "ev-x",
          tenant: "acme",
          kind: "campaign.adoption_registered",
          subject: { type: "campaign", id: "camp-1" },
          actor: "alice",
          payload: {},
          at: "t",
        },
      ] as never),
    ).toBe("already_registered");
    expect(store.outbox().length, "a refused spend still wrote its fact").toBe(refused);
  });

  it("finds the authorizations an ISSUE owns, and only that issue's", async () => {
    // The lookup the completion watch performs, through the proof's own issueId — never a duplicated
    // column, which would be a second copy of a value the proof already owns.
    const { store } = await settled("sha256:c1");

    expect(await store.forIssue("acme", "iss-9")).toHaveLength(1);
    expect(await store.forIssue("acme", "iss-other")).toEqual([]);
  });

  it("REFUSES to discharge on a proof that is not the one recorded", async () => {
    const { store, proof } = await settled("sha256:c1");
    await store.markRegistered("acme", "camp-1", contentDigest(proof), "1.1.0");

    expect(await store.markCompleted("acme", "camp-1", "sha256:forged")).toBe("proof_mismatch");
    expect((await store.forCampaign("acme", "camp-1"))?.state).toBe("registered");
  });

  it("REFUSES a proof that is not the one recorded", async () => {
    // The substitution the review named: a structurally-plausible proof the campaign never issued. Compared
    // as a digest of what was STORED, never against the object the caller handed over.
    const { store } = await settled("sha256:c1");
    const forged = contentDigest({ campaignId: "camp-1", candidate: { version: "9.9.9" } });

    expect(await store.markRegistered("acme", "camp-1", forged, "9.9.9")).toBe("proof_mismatch");
    expect((await store.forCampaign("acme", "camp-1"))?.state, "a forged proof spent the authorization").toBe(
      "decided",
    );
  });

  it("answers ANOTHER WORKSPACE nothing at all (arch-review 74, self-review)", async () => {
    // The twin ignored the tenant on all four adoption methods while `PgAdoptionOperationStore` filters on
    // it — more permissive than production on the one axis where that is worst, and invisible to every unit
    // test because no fixture ever passed a second workspace (rule `testing`).
    const { store, proof } = await settled("sha256:c1");
    const digest = contentDigest(proof);

    expect(await store.forCampaign("other", "camp-1"), "another workspace read acme's authorization").toBeUndefined();
    expect(await store.forIssue("other", "iss-9")).toEqual([]);
    expect(
      await store.markRegistered("other", "camp-1", digest, "1.1.0"),
      "another workspace spent acme's authorization",
    ).toBe("no_such_operation");
    expect(await store.markCompleted("other", "camp-1", digest)).toBe("no_such_operation");
    // …and acme's own row is untouched by any of it.
    expect((await store.forCampaign("acme", "camp-1"))?.state).toBe("decided");
  });

  it("has NOTHING to spend for a campaign that never adopted", async () => {
    // A save claiming campaign-adopted provenance against a campaign with no authorization is refused by
    // the absence itself — which is what makes the generic authoring API safe to keep.
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record([round()]));

    expect(await store.markRegistered("acme", "camp-1", "sha256:whatever", "1.1.0")).toBe("no_such_operation");
  });

  it("authorizes NOTHING when the close is refused", async () => {
    // The atomicity that makes the operation trustworthy: a stale gate answer (a round landed since the
    // read) closes nothing, so it must authorize nothing either.
    const store = new InMemoryEvolutionCampaignStore();
    const rec = record([round("sha256:c1")]);
    await store.create(rec);
    const proof = adoptionProofOf(campaignAdoption(rec.frame, rec.rounds), rec, rec.rounds);
    if (proof === undefined) throw new Error("unreachable");

    // `expectedRounds` disagrees with the record — the CAS the close already had.
    const outcome = await store.close("acme", rec.id, "adopted", closeDoc("1.1.0"), 99, undefined, {
      operationId: "adopt/acme/camp-1",
      tenant: "acme",
      proof,
      state: "decided",
      createdAt: "2026-08-27T01:00:00.000Z",
      updatedAt: "2026-08-27T01:00:00.000Z",
    });

    expect(outcome.kind).toBe("conflict");
    expect(
      await store.forCampaign("acme", "camp-1"),
      "a refused close still authorized a registry write",
    ).toBeUndefined();
  });
});
