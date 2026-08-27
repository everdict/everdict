import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";
import { CampaignAdoptionService } from "./campaign-adoption-service.js";

// ── AN AUTHORIZATION NOBODY SPENDS IS DECORATION (arch-review 72 P0) ────────────────────────────────
//
// arch-review 71 built `CampaignAdoptionProof` and a durable `AdoptionOperation` written atomically with the
// campaign close, and stopped there. `PgAdoptionOperationStore` was written, exported, tested — and NOTHING
// anywhere accepted the port. The defect moved rather than closed:
//
//     before   there is no operation
//     after    the operation is durable and no production effect consumes it
//
// Third form of one law, third time shipped (64: no producer · 67: a missed consumer · 72: no consumer at
// all), and `pnpm unwired-capabilities` now catches this shape — it did not, because it only inspected
// ports somebody had already declared as a dependency.
//
// The other half of the P0 was that the spend did not bind the effect: `markRegistered` took the version as
// a separate argument and recorded whatever it was handed, so a correct proof could register 9.9.9.
//
// Seen RED before the service existed, observed:
//   a correct proof registered a version it never authorized: expected [Function] to throw

const PROOF: CampaignAdoptionProof = {
  campaignId: "camp-1",
  frameDigest: "sha256:frame",
  roundSeq: 2,
  candidate: { identity: "exact", type: "agent", id: "a1", version: "1.1.0", specDigest: "sha256:c1" },
  provingScorecardId: "sc-cand",
  issueId: "iss-9",
  gateDigest: "sha256:gate",
};

const CANDIDATE = { type: "agent" as const, id: "a1", version: "1.1.0", specDigest: "sha256:c1" };

// A store holding one decided authorization, and recording what was spent — the real one's shape.
function operations(over: Partial<AdoptionOperation> = {}) {
  let op: AdoptionOperation | undefined = {
    operationId: "adopt/acme/camp-1",
    tenant: "acme",
    proof: PROOF,
    state: "decided",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
  const store: AdoptionOperationStore = {
    async forCampaign() {
      return op;
    },
    async markRegistered(_t, _c, proofDigest, registeredVersion) {
      if (op === undefined) return "no_such_operation";
      if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
      if (op.state !== "decided") return "already_registered";
      op = { ...op, state: "registered", registeredVersion };
      return "registered";
    },
  };
  return { store, current: () => op };
}

const serviceOver = (store: AdoptionOperationStore, registered: string[]) =>
  new CampaignAdoptionService({
    operations: store,
    register: async ({ proof }) => {
      registered.push(proof.candidate.version);
      return { version: proof.candidate.version };
    },
  });

describe("[R72 COUNTEREXAMPLE] the registry effect spends the authorization it was given", () => {
  it("registers and SPENDS, once", async () => {
    const { store, current } = operations();
    const registered: string[] = [];

    const outcome = await serviceOver(store, registered).adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: PROOF,
      candidate: CANDIDATE,
    });

    expect(outcome.kind).toBe("adopted");
    expect(registered, "the effect never ran").toEqual(["1.1.0"]);
    expect(current()?.state).toBe("registered");
    expect(current()?.registeredVersion).toBe("1.1.0");
  });

  it("REFUSES a correct proof spent on a different version", async () => {
    // The half that made the proof decorative: the version was a separate argument and whatever arrived was
    // recorded. Every coordinate the proof carries is compared at the seam that performs the effect.
    const { store, current } = operations();
    const registered: string[] = [];

    await expect(
      serviceOver(store, registered).adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: PROOF,
        candidate: { ...CANDIDATE, version: "9.9.9" },
      }),
      "a correct proof registered a version it never authorized",
    ).rejects.toThrow(/different candidate/);
    expect(registered, "the effect ran before the mismatch was caught").toEqual([]);
    expect(current()?.state).toBe("decided");
  });

  it("REFUSES a different id, a different type, and different BYTES", async () => {
    for (const candidate of [
      { ...CANDIDATE, id: "a2" },
      { ...CANDIDATE, type: "harness" as const },
      { ...CANDIDATE, specDigest: "sha256:c2" },
      { ...CANDIDATE, specDigest: undefined },
    ]) {
      const { store } = operations();
      await expect(
        serviceOver(store, []).adopt({ tenant: "acme", campaignId: "camp-1", proof: PROOF, candidate }),
      ).rejects.toThrow(/different candidate/);
    }
  });

  it("REFUSES a proof the campaign never issued", async () => {
    const { store } = operations();
    const forged = { ...PROOF, gateDigest: "sha256:forged" };

    await expect(
      serviceOver(store, []).adopt({ tenant: "acme", campaignId: "camp-1", proof: forged, candidate: CANDIDATE }),
    ).rejects.toThrow(/not the one this campaign recorded/);
  });

  it("REFUSES when the campaign authorized nothing at all", async () => {
    const empty: AdoptionOperationStore = {
      async forCampaign() {
        return undefined;
      },
      async markRegistered() {
        return "no_such_operation";
      },
    };
    await expect(
      serviceOver(empty, []).adopt({ tenant: "acme", campaignId: "camp-1", proof: PROOF, candidate: CANDIDATE }),
    ).rejects.toThrow(/never authorized an adoption/);
  });

  it("converges on an at-least-once retry rather than adopting twice", async () => {
    const { store } = operations();
    const registered: string[] = [];
    const svc = serviceOver(store, registered);

    await svc.adopt({ tenant: "acme", campaignId: "camp-1", proof: PROOF, candidate: CANDIDATE });
    const second = await svc.adopt({ tenant: "acme", campaignId: "camp-1", proof: PROOF, candidate: CANDIDATE });

    expect(second.kind, "a second consumer was granted its own adoption").toBe("already_adopted");
    expect(registered, "the effect ran twice for one authorization").toEqual(["1.1.0"]);
  });

  it("does NOT spend the authorization when the registry write fails", async () => {
    // The ordering that makes a crash recoverable: the effect first, the spend after. Spending first would
    // leave `registered` over a capability that does not exist — a lie no read can detect.
    const { store, current } = operations();
    const svc = new CampaignAdoptionService({
      operations: store,
      register: async () => {
        throw new Error("the registry refused the write");
      },
    });

    await expect(
      svc.adopt({ tenant: "acme", campaignId: "camp-1", proof: PROOF, candidate: CANDIDATE }),
    ).rejects.toThrow(/refused the write/);
    expect(current()?.state, "a failed registration spent its authorization anyway").toBe("decided");
  });
});
