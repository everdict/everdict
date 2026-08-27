import {
  type AdoptionOperationStore,
  CampaignAdoptionService,
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  type IssueResolutionView,
} from "@everdict/application-control";
import type { AgentRegistry } from "@everdict/application-control";
import {
  AgentSpecSchema,
  BadRequestError,
  ConflictError,
  HarnessInstanceSpecSchema,
  resolveHarnessInstance,
} from "@everdict/contracts";
import { digestUnder } from "@everdict/domain";

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
  // The tracker read the completion join needs — see `CampaignAdoptionDeps.issues`. REQUIRED: an optional
  // one would make the reverse ordering silently unjoined again (arch-review 76).
  issues: { get(tenant: string, ref: string): Promise<IssueResolutionView> };
  // The template half of a harness's identity. REQUIRED, because the digest has to be provable BEFORE the
  // write and a harness cannot be resolved without it — an optional one would silently degrade the check to
  // the post-write shape this whole finding is about (arch-review 76).
  templates: HarnessTemplateRegistry;
}

export function buildCampaignAdoption(deps: CampaignAdoptionWiring): CampaignAdoptionService {
  return new CampaignAdoptionService({
    operations: deps.operations,
    issues: deps.issues,
    // ── THE DIGEST IS PROVED BEFORE THE WRITE, NOT AFTER IT (arch-review 76 P0) ─────────────────────
    //
    // The first version registered, read back, and threw on a mismatch. That is the right ANSWER at the
    // wrong MOMENT: registry versions are immutable, so by the time the mismatch was found the label already
    // held the wrong bytes — and the honest retry that follows is refused by immutability forever.
    //
    //     proof authorizes D1 · label absent · caller submits C2
    //     register(C2) → readback D2 ≠ D1 → throw, operation stays `decided`
    //     honest retry with C1 → 409 immutable, this campaign can NEVER be adopted
    //
    // The comment defending the ordering said "`decided` over a capability that EXISTS is recoverable"; that
    // is true only when the capability is the right one. Rule `protocol` L1 in its plainest form: no
    // irreversible external effect until the authority for it has been proved.
    //
    // Both lanes can resolve WITHOUT writing. An agent's stored document is the parsed spec. A harness's is
    // `resolveHarnessInstance(template, instance)` — a pure function in contracts, which is exactly what
    // `HarnessInstanceRegistry.get` composes. So the digest is computed from the same composition the
    // registry would produce, compared, and only then written.
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
      // it ACCUSES (rule `suite`).
      const measured = proof.candidate.specDigest;
      const digestOf = (document: unknown): string | undefined =>
        measured === undefined ? undefined : digestUnder(measured, document);
      const refuseSpec = (specId: string, specVersion: string): never => {
        throw new BadRequestError(
          "BAD_REQUEST",
          { spec: `${specId}@${specVersion}`, authorized: `${id}@${version}` },
          `the spec presented is ${specId}@${specVersion} and this campaign authorized ${id}@${version}`,
        );
      };
      // The pre-write refusal. `measured === undefined` is a label-only adoption: there is nothing to prove
      // against, and the frame had to record that waiver at open for the gate to have authorized it at all.
      const refuseDigest = (would: string | undefined): never => {
        throw new ConflictError(
          "CONFLICT",
          { campaign: proof.campaignId, would: would ?? null, measured },
          would === undefined
            ? "the candidate presented cannot be resolved to a document, so it cannot be checked against what this campaign measured — nothing was registered"
            : `the candidate presented resolves to ${would}, and this campaign proved ${measured} — nothing was registered`,
        );
      };

      if (type === "agent") {
        const parsed = AgentSpecSchema.parse(spec);
        if (parsed.id !== id || parsed.version !== version) refuseSpec(parsed.id, parsed.version);
        // An agent's stored document IS the parsed spec — the registry keeps what it is given — so this is
        // the byte-for-byte document a later `get` returns.
        const would = digestOf(parsed);
        if (measured !== undefined && would !== measured) refuseDigest(would);
        // ── THE ADOPTED VERSION STAYS WITH ITS TEAM, WITHOUT A WINDOW (wave C · 74 · 77) ─────────────
        //
        // Ownership is read off the entity, so a successor registered with no team re-files the whole agent
        // out of its team's list the moment it becomes latest (wave C, re-learned in 74). Reading the owner
        // HERE and writing it below leaves a window an ownership transfer fits through — and detecting that
        // afterwards is the write-then-verify shape arch-review 76 removed. So the store resolves the owner
        // inside the statement that writes (arch-review 77).
        const existed = await deps.agents.has(tenant, id, version);
        await deps.agents.registerPreservingOwner(tenant, parsed, by, origin);
        // Read back anyway: defence in depth, and the only thing that can see a registry which stored
        // something other than what it was handed. The correctness gate is above; this is the audit.
        const held = digestOf(await deps.agents.get(tenant, id, version));
        return {
          kind: existed ? ("already_exists" as const) : ("created" as const),
          candidate: { type, id, version, ...(held !== undefined ? { specDigest: held } : {}) },
        };
      }

      const parsed = HarnessInstanceSpecSchema.parse(spec);
      if (parsed.id !== id || parsed.version !== version) refuseSpec(parsed.id, parsed.version);
      // A harness's stored document is the RESOLVED one — template + pins — which is what a scorecard
      // manifest seals and what `HarnessInstanceRegistry.get` composes. Composed here from the same pure
      // function, so the digest proved before the write is the digest a later read produces.
      const template = await deps.templates.get(tenant, parsed.template.id, parsed.template.version);
      const wouldResolve = resolveHarnessInstance(template, parsed);
      const would = digestOf(wouldResolve);
      if (measured !== undefined && would !== measured) refuseDigest(would);
      const existed = (await deps.harnesses.ownVersions(tenant, id)).includes(version);
      await deps.harnesses.registerPreservingOwner(tenant, parsed, by, origin);
      const held = digestOf(await deps.harnesses.get(tenant, id, version));
      return {
        kind: existed ? ("already_exists" as const) : ("created" as const),
        candidate: { type, id, version, ...(held !== undefined ? { specDigest: held } : {}) },
      };
    },
  });
}
