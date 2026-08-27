import {
  type AdoptionOperationStore,
  CampaignAdoptionService,
  type HarnessInstanceRegistry,
} from "@everdict/application-control";
import type { AgentRegistry } from "@everdict/application-control";
import { AgentSpecSchema, BadRequestError, HarnessInstanceSpecSchema } from "@everdict/contracts";
import { digestUnder } from "@everdict/domain";
import { teamOfEntity } from "../common/team-scope.js";

// ── THE CONSUMER OF WHAT A SETTLE AUTHORIZED (arch-review 72 P0 / 73) ────────────────────────────────
//
// The campaign settles and writes an authorization; this spends it. Two halves of one protocol, wired in two
// places because their dependencies differ — the settlement's is the campaign store, this one's is the
// REGISTRY. arch-review 72 shipped `CampaignAdoptionService` with no constructor anywhere, which is the
// third form of "a constructed capability is not a delivered one".
//
// It is a NAMED FUNCTION in `composition/` rather than an inline literal in `main.ts` for the reason the
// durability policy already is: a closure inside the composition root is production code no test can reach,
// so its counterexample would have to build its own — and a fixture that builds the thing under test has
// proved nothing about the deployment (rule `testing`).
export interface CampaignAdoptionWiring {
  operations: AdoptionOperationStore;
  agents: AgentRegistry;
  harnesses: HarnessInstanceRegistry;
}

export function buildCampaignAdoption(deps: CampaignAdoptionWiring): CampaignAdoptionService {
  return new CampaignAdoptionService({
    operations: deps.operations,
    // The effect. It registers the caller's spec at the AUTHORIZED version — never one the caller named —
    // and then answers with what the registry RESOLVES there. Immutable versions make identical bytes an
    // idempotent no-op and different bytes a conflict, so a substitution is refused by the registry itself;
    // the read-back is what proves the label points at the measured document rather than merely at a write
    // nobody rejected.
    register: async ({ tenant, by, via, proof, spec }) => {
      const { type, id, version } = proof.candidate;
      // The origin the adopted version is born with: the campaign's ISSUE is the intent hub, and the note
      // names the campaign, the round and the scorecard that proved it — so "why does this version exist"
      // is answerable from the registry alone, which is what `CapabilityOrigin` exists for.
      //
      // `via` is the CHANNEL the request arrived through, carried from the transport. Hardcoding one (this
      // said `mcp` in its first draft) files every HTTP adoption under a channel it did not use — a fact
      // about the request, stated wrong, in the one field whose whole job is to record it (L3).
      const origin = {
        via,
        from: { type: "issue" as const, id: proof.issueId },
        note: `adopted by campaign ${proof.campaignId} (round ${proof.roundSeq}, proved by scorecard ${proof.provingScorecardId})`,
      };
      // `digestUnder`, never a direct `contentDigest` compare: a stamp sealed under an older algorithm has
      // to keep verifying, and a direct comparison is fail-CLOSED in the way that hurts — it does not miss,
      // it ACCUSES (rule `suite`). Absent proof digest → nothing to compare, and the service treats an
      // absent answer as "could not check" rather than as a match.
      const digestOf = (document: unknown): string | undefined =>
        proof.candidate.specDigest === undefined ? undefined : digestUnder(proof.candidate.specDigest, document);
      const refuseSpec = (specId: string, specVersion: string): never => {
        throw new BadRequestError(
          "BAD_REQUEST",
          { spec: `${specId}@${specVersion}`, authorized: `${id}@${version}` },
          `the spec presented is ${specId}@${specVersion} and this campaign authorized ${id}@${version}`,
        );
      };
      if (type === "agent") {
        const parsed = AgentSpecSchema.parse(spec);
        if (parsed.id !== id || parsed.version !== version) refuseSpec(parsed.id, parsed.version);
        // ── THE ADOPTED VERSION STAYS WITH ITS TEAM (review wave C, re-learned here) ─────────────────
        //
        // Ownership is read off an entity's NEWEST own version, so registering a successor with no team
        // re-files the whole agent out of its team's list the moment it becomes latest. `saveAgent` learned
        // that in review wave C and the re-pin learned it through the now-required `teamOfVersion`; this
        // door was written afterwards and did not — the one-lane-only shape, in a lane that did not exist
        // when the lesson was paid for. `teamOfEntity` is the single owner of the question.
        const owner = await teamOfEntity(deps.agents, tenant, id);
        // `has` BEFORE the write, so the outcome can say whether this call created the version or found it
        // already there. Both are success under an immutable registry; telling them apart is what makes an
        // at-least-once retry legible (arch-review 75).
        const existed = await deps.agents.has(tenant, id, version);
        await deps.agents.register(tenant, parsed, by, owner.teamId, origin);
        const held = digestOf(await deps.agents.get(tenant, id, version));
        return {
          kind: existed ? ("already_exists" as const) : ("created" as const),
          candidate: { type, id, version, ...(held !== undefined ? { specDigest: held } : {}) },
        };
      }
      const parsed = HarnessInstanceSpecSchema.parse(spec);
      if (parsed.id !== id || parsed.version !== version) refuseSpec(parsed.id, parsed.version);
      const owner = await teamOfEntity(deps.harnesses, tenant, id);
      const existed = await deps.harnesses.has(tenant, id, version);
      await deps.harnesses.register(tenant, parsed, by, owner.teamId, origin);
      // The RESOLVED harness (template + pins) — the document `manifest.harness.specDigest` seals, which is
      // NOT the instance spec just written. Digesting the instance would compare a hash of the wrong
      // document and refuse every honest adoption.
      const held = digestOf(await deps.harnesses.get(tenant, id, version));
      return {
        kind: existed ? ("already_exists" as const) : ("created" as const),
        candidate: { type, id, version, ...(held !== undefined ? { specDigest: held } : {}) },
      };
    },
  });
}
