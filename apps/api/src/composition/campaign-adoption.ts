import {
  type AdoptionOperationStore,
  CampaignAdoptionService,
  type EnvironmentRegistry,
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  type IssueResolutionView,
} from "@everdict/application-control";
import type { AgentRegistry, GithubAppService } from "@everdict/application-control";
import { NotFoundError } from "@everdict/contracts";
import {
  AgentSpecSchema,
  BadRequestError,
  ConflictError,
  EnvironmentSpecSchema,
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
  // The environment lane's registry (harness-definability-spec.md §2). REQUIRED for the same reason
  // `templates` is: an environment candidate cannot be resolved without it, and an optional one would
  // silently send an environment down the harness branch — the "a new lane inherits every constraint"
  // failure this file already carries a case of.
  environments: EnvironmentRegistry;
  // The workspace GitHub App, for the CODE half of an adoption (docs/architecture/code-evolution-loop.md, D5).
  // Optional at the ROOT because a deployment may run without GitHub; the service's dependency stays required
  // and is bound to a merge that refuses by name, so "no App" is a 404 the caller reads, never a silent skip.
  github?: Pick<GithubAppService, "mergePullRequest">;
}

export function buildCampaignAdoption(deps: CampaignAdoptionWiring): CampaignAdoptionService {
  return new CampaignAdoptionService({
    operations: deps.operations,
    issues: deps.issues,
    // The code debt's effect: merge the pull request the proof names, asserting the head the round measured.
    // The repository and pull request come from the STORED operation (the service reads them), never from the
    // caller — what lands on the default branch is what the campaign proved.
    merge: async ({ tenant, repo, prNumber, expectedSha }) => {
      if (deps.github === undefined)
        throw new NotFoundError(
          "NOT_FOUND",
          { repo, prNumber },
          "no workspace GitHub App is configured on this deployment, so the adopted pull request cannot be merged from here — merge it in GitHub and the debt stays recorded as owed",
        );
      return await deps.github.mergePullRequest(tenant, repo, prNumber, {
        ...(expectedSha !== undefined ? { sha: expectedSha } : {}),
        message: "Adopted by everdict campaign — proved by an evolution round",
      });
    },
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
        // ── LOCAL EXISTENCE, NOT RESOLVE-EXISTENCE (arch-review 115) ──────────────────────────────
        //
        // `has()` falls back to `_shared`, so a candidate that exists only there answered TRUE while this
        // write goes on to create the workspace's FIRST local version — reporting `created: false` about a
        // version being born. The harness lane below already used `ownVersions` (tenant-local, "no fallback
        // — for conflict checks"); one fact, two lanes, two meanings.
        const existed = (await deps.agents.ownVersions(tenant, id)).includes(version);
        await deps.agents.register(tenant, parsed, by, origin);
        // Read back anyway: defence in depth, and the only thing that can see a registry which stored
        // something other than what it was handed. The correctness gate is above; this is the audit.
        const held = digestOf(await deps.agents.get(tenant, id, version));
        return {
          kind: existed ? ("already_exists" as const) : ("created" as const),
          candidate: { type, id, version, ...(held !== undefined ? { specDigest: held } : {}) },
        };
      }

      // ── THE ENVIRONMENT LANE ──────────────────────────────────────────────────────────────────
      //
      // Placed BEFORE the harness fall-through on purpose: the branch used to be `agent` or else-harness, so a
      // third subject type would have been registered into the harness registry with an EnvironmentSpec body.
      // An environment's stored document IS the parsed spec (the registry keeps what it is given), so the
      // digest is provable before the write, exactly like the agent lane's.
      if (type === "environment") {
        const parsedEnv = EnvironmentSpecSchema.parse(spec);
        if (parsedEnv.id !== id || parsedEnv.version !== version) refuseSpec(parsedEnv.id, parsedEnv.version);
        const wouldEnv = digestOf(parsedEnv);
        if (measured !== undefined && wouldEnv !== measured) refuseDigest(wouldEnv);
        const existedEnv = (await deps.environments.ownVersions(tenant, id)).includes(version);
        await deps.environments.register(tenant, parsedEnv, by, origin);
        const heldEnv = digestOf(await deps.environments.get(tenant, id, version));
        return {
          kind: existedEnv ? ("already_exists" as const) : ("created" as const),
          candidate: { type, id, version, ...(heldEnv !== undefined ? { specDigest: heldEnv } : {}) },
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
      // Same authority precondition and same initial owner as the agent lane — one shape, both lanes, because
      // a guarantee one lane carries and the other does not is how this axis has come apart every time.
      await deps.harnesses.register(tenant, parsed, by, origin);
      const held = digestOf(await deps.harnesses.get(tenant, id, version));
      return {
        kind: existed ? ("already_exists" as const) : ("created" as const),
        candidate: { type, id, version, ...(held !== undefined ? { specDigest: held } : {}) },
      };
    },
  });
}
