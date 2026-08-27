import type { AdoptionOperation, CampaignAdoptionProof, CapabilityOriginChannel } from "@everdict/contracts";
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
  // The effect itself, injected: this package owns no registry. It takes the SPEC the caller is registering
  // and answers with what the registry now HOLDS at that version — the version, and the digest of the
  // document a later read resolves to.
  //
  // ── WHY THE DIGEST IS READ BACK RATHER THAN COMPUTED HERE (arch-review 73) ──────────────────────────
  //
  // The obvious implementation is `contentDigest(input.spec)` in this file, and it can never match. A
  // scorecard's `manifest.harness.specDigest` seals the RESOLVED harness document (template + pins), which
  // is what `HarnessInstanceRegistry.get` returns and what the drift check in `ScorecardService` already
  // re-derives — while what a caller registers is the INSTANCE spec. Two different documents; digesting the
  // caller's copy would compare a hash of the wrong thing and refuse every honest adoption.
  //
  // So the effect resolves it: register (immutable versions make identical bytes an idempotent no-op and
  // different bytes a conflict), then read the resolved document back and digest THAT. `specDigest` absent
  // means the deployment could not resolve one — never "it matched".
  register: (input: {
    tenant: string;
    by: string;
    // The CHANNEL the request arrived through — a fact about the request, carried rather than assumed. The
    // adopted version's birth stamp records it, and a hardcoded one files every caller under the wrong door.
    via: CapabilityOriginChannel;
    proof: CampaignAdoptionProof;
    spec: unknown;
    //
    // ── AND IT ANSWERS WITH THE WHOLE IDENTITY, NOT JUST A VERSION (arch-review 75 P1-high) ─────────
    //
    // The first version returned `{version}` and the service recorded whatever came back. An adapter bound
    // to a server-side-versioning door — `save_agent` auto patch-bumps a changed spec — would answer 1.1.1
    // for a proof authorizing 1.1.0, and the operation would be marked `registered` at a version the
    // campaign never proved. The pre-effect comparison cannot see that: it checks the REQUEST, and this is
    // about the RESULT.
    //
    // So the effect reports the identity the registry now holds, and every coordinate of it is compared
    // again before the authorization is spent. `kind` distinguishes a write that created the version from
    // one that found it already there — both are success under an idempotent registry, and telling them
    // apart is what makes an at-least-once retry legible instead of ambiguous.
  }) => Promise<RegistrationOutcome>;
}

// What the registry now holds at the adopted label, reported by the effect rather than assumed by its
// caller. `already_exists` is the ordinary path: the candidate version was registered when it was evaluated,
// so an honest adoption re-presents identical bytes and the immutable store makes that a no-op.
export interface RegistrationOutcome {
  kind: "created" | "already_exists";
  candidate: { type: "agent" | "harness"; id: string; version: string; specDigest?: string };
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
  // The bytes being registered. Passed through to the effect rather than digested here — see the note on
  // `register` for why the digest a proof carries is not a hash of this document.
  spec: unknown;
  by: string; // the subject the registration is attributed to
  via: CapabilityOriginChannel; // …and the door it came through
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
    const landed = await this.deps.register({
      tenant: input.tenant,
      by: input.by,
      via: input.via,
      proof: recorded.proof,
      spec: input.spec,
    });
    // ── …AND WHAT LANDED IS WHAT WAS MEASURED (arch-review 73) ──────────────────────────────────────
    //
    // The caller's claim about its own bytes was checked above; this checks the REGISTRY's. An immutable
    // version makes a substituted spec a conflict, so the ordinary path is a no-op — but "the write did not
    // throw" is not "the document under this label is the one the campaign evaluated", and a deployment
    // whose registry resolves a version through a template can hold something the caller never sent.
    //
    // A disagreement leaves the operation `decided` over a capability that exists, which is the recoverable
    // direction (an operator re-drives it once the label points at the measured bytes). Spending first and
    // discovering the mismatch after would record `registered` over an adoption that never happened.
    const authorizedCandidate = recorded.proof.candidate;
    const landedCandidate = landed.candidate;
    const measured = authorizedCandidate.specDigest;
    const drift =
      landedCandidate.type !== authorizedCandidate.type
        ? `type ${landedCandidate.type} (authorized: ${authorizedCandidate.type})`
        : landedCandidate.id !== authorizedCandidate.id
          ? `id ${landedCandidate.id} (authorized: ${authorizedCandidate.id})`
          : // The one a server-side-versioning door produces: an auto patch-bump answering 1.1.1 for a proof
            // that authorized 1.1.0. Recording that would mark the operation spent on a version the campaign
            // never proved.
            landedCandidate.version !== authorizedCandidate.version
            ? `version ${landedCandidate.version} (authorized: ${authorizedCandidate.version})`
            : measured !== undefined && landedCandidate.specDigest !== measured
              ? landedCandidate.specDigest === undefined
                ? `no resolvable document (this campaign proved ${measured})`
                : `spec digest ${landedCandidate.specDigest} (this campaign proved ${measured})`
              : undefined;
    if (drift !== undefined)
      throw new ConflictError(
        "CONFLICT",
        { campaign: input.campaignId, drift, landed: landedCandidate, authorized: authorizedCandidate },
        `the registry now holds a different capability than this campaign authorized — ${drift}. The authorization stays unspent`,
      );
    const spent = await this.deps.operations.markRegistered(
      input.tenant,
      input.campaignId,
      authorized,
      landedCandidate.version,
    );
    if (spent === "already_registered") return { kind: "already_adopted", version: landedCandidate.version };
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
    return { kind: "adopted", operation, version: landedCandidate.version };
  }
}
