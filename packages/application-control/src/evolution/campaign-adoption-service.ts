import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import { ConflictError, NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";

// ── AN AUTHORIZATION IS SPENT BY THE EFFECT, OR IT IS DECORATION (arch-review 72 P0) ────────────────
//
// arch-review 71 built the proof and the durable operation and stopped there: `PgAdoptionOperationStore`
// existed, was exported, was tested — and nothing anywhere accepted the port. So the defect moved rather
// than closed:
//
//     before   there is no operation
//     after    the operation is durable and no production effect consumes it
//
// That is the same law in its third form (64: no producer · 67: a missed consumer · 72: no consumer at
// all), and `pnpm unwired-capabilities` now catches this shape too.
//
// This service is the consumer. It is the ONE place that turns "the gate authorized a version" into "this
// registry write is that version", and it exists as a service rather than as a check inside the registry
// because the comparison is the protocol: a registry that merely accepted a proof-shaped argument would be
// doing the annotation thing this whole review series is about.
export interface CampaignAdoptionDeps {
  operations: AdoptionOperationStore;
  // The effect itself, injected: this package owns no registry. It returns the version that actually landed,
  // so the operation records a version somebody can go look at rather than the one we hoped for.
  register: (input: { proof: CampaignAdoptionProof }) => Promise<{ version: string }>;
}

export type AdoptionOutcome =
  | { kind: "adopted"; operation: AdoptionOperation; version: string }
  // Already spent by an at-least-once retry of the SAME adoption — success, not a second authorization.
  | { kind: "already_adopted"; version?: string };

// What the caller must present, and every field of it is checked. A proof that is merely well-formed
// authorizes nothing: it has to be the one this campaign recorded, and the candidate has to be the one the
// proof names — down to the bytes when the campaign could name them.
export interface AdoptionRequest {
  tenant: string;
  campaignId: string;
  proof: CampaignAdoptionProof;
  candidate: { type: "agent" | "harness"; id: string; version: string; specDigest?: string };
}

export class CampaignAdoptionService {
  constructor(private readonly deps: CampaignAdoptionDeps) {}

  async adopt(input: AdoptionRequest): Promise<AdoptionOutcome> {
    const recorded = await this.deps.operations.forCampaign(input.tenant, input.campaignId);
    if (recorded === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { campaign: input.campaignId },
        "this campaign never authorized an adoption — settle it through the gate first",
      );
    // AUTHORITY IS THE STORED PROOF, never the one handed over (rule `protocol` L3). A structurally-equal
    // proof the campaign never issued is not authority, so the comparison is against a digest of the row.
    const authorized = contentDigest(recorded.proof);
    if (contentDigest(input.proof) !== authorized)
      throw new ConflictError(
        "CONFLICT",
        { campaign: input.campaignId },
        "the proof presented is not the one this campaign recorded",
      );
    // ── …AND THE CANDIDATE IS THE ONE THE PROOF NAMES ────────────────────────────────────────────────
    //
    // The half that makes the proof mean something. `markRegistered` used to take the version as a separate
    // argument and record whatever it was handed: a correct proof could register 9.9.9. Every coordinate the
    // proof carries is compared here, at the ONE seam that performs the effect.
    const want = recorded.proof.candidate;
    const mismatch =
      want.type !== input.candidate.type
        ? `type ${input.candidate.type} (authorized: ${want.type})`
        : want.id !== input.candidate.id
          ? `id ${input.candidate.id} (authorized: ${want.id})`
          : want.version !== input.candidate.version
            ? `version ${input.candidate.version} (authorized: ${want.version})`
            : // Bytes, when the campaign could name them. An authorization that names a digest may only be
              // spent on those exact bytes — this is the C1-evaluated/C2-saved substitution, refused.
              want.specDigest !== undefined && want.specDigest !== input.candidate.specDigest
              ? `spec digest ${input.candidate.specDigest ?? "absent"} (authorized: ${want.specDigest})`
              : undefined;
    if (mismatch !== undefined)
      throw new ConflictError(
        "CONFLICT",
        { campaign: input.campaignId, mismatch },
        `this adoption authorizes a different candidate — ${mismatch}`,
      );
    if (recorded.state !== "decided")
      return {
        kind: "already_adopted",
        ...(recorded.registeredVersion ? { version: recorded.registeredVersion } : {}),
      };

    // ── THE EFFECT FIRST, THEN THE SPEND (arch-review 72 P1) ─────────────────────────────────────────
    //
    // Two orderings, and only one of them is recoverable. Spending first leaves `registered` over a
    // capability that does not exist — a lie no read can detect. Registering first leaves `decided` over a
    // capability that does, which the next attempt converges on: the registry write is idempotent by
    // version, so re-driving it lands on the same row and the spend follows.
    //
    // So a crash between them is the honest state, and it is the one that can be repaired.
    const { version } = await this.deps.register({ proof: recorded.proof });
    const spent = await this.deps.operations.markRegistered(input.tenant, input.campaignId, authorized, version);
    if (spent === "already_registered") return { kind: "already_adopted", version };
    if (spent !== "registered")
      throw new ConflictError(
        "CONFLICT",
        { campaign: input.campaignId, outcome: spent },
        `the registry write landed but its authorization could not be spent (${spent})`,
      );
    const operation = await this.deps.operations.forCampaign(input.tenant, input.campaignId);
    if (operation === undefined)
      throw new ConflictError(
        "CONFLICT",
        { campaign: input.campaignId },
        "the authorization vanished between spending it and reading it back",
      );
    return { kind: "adopted", operation, version };
  }
}
