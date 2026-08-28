import type { AdoptionOperationStore } from "@everdict/application-control";
import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import { AgentSpecSchema } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { InMemoryAgentRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildCampaignAdoption } from "./campaign-adoption.js";

// ── AN AUTHORIZATION NOBODY SPENDS IS DECORATION (arch-review 72 P0 / 73) ───────────────────────────
//
// arch-review 71 wrote the proof and the durable operation. arch-review 72 wrote the SERVICE that spends it
// and stopped one step short of the same line: nothing in `apps/api` constructed one, so the consumer was
// itself unconsumed. `pnpm unwired-capabilities` cannot see this shape — it asks whether an optional PORT
// has an implementation somewhere, and `CampaignAdoptionService` is neither a port nor optional; it is a
// service class nobody called `new` on.
//
//     the consumer exists   ≠   a deployment reaches it
//
// So this drives the PRODUCTION closure (`buildCampaignAdoption`, the one `main.ts` calls) against a real
// registry. Two things only a real registry can show, and both are why the digest is read back rather than
// computed from the caller's bytes:
//
//   · versions are immutable, so re-registering identical content is an idempotent no-op and different
//     content under the same label is a ConflictError — the substitution refusal is the REGISTRY's, not a
//     check we wrote;
//   · what a later read RESOLVES is the document a scorecard manifest digests, and it is not always the
//     document that was written.
//
// Seen RED before the composition existed, observed:
//   the deployment has no way to spend an authorization: buildCampaignAdoption is not a function

const SPEC = {
  id: "a1",
  version: "1.1.0",
  instructions: "structure over phrasing",
  mcpServers: [],
  capabilities: [],
};

// The digest the campaign would have sealed: whatever the REGISTRY resolves for this version.
//
// ⚠️ Seeded through the SAME parse the production closure performs. Registering the literal above instead
// produced a different digest and two red tests — `AgentSpecSchema` fills five defaults (`disabledDefaults`,
// `toolSecretBindings`, `triggers`, `enabled`, `tags`), so the stored document is not the object written
// here. That is a fixture artifact rather than a production defect (every door parses), and it is the
// sharpest possible demonstration of why the digest is READ BACK from the registry: a hash of the caller's
// copy is a hash of a document the registry does not hold.
async function measuredDigest(): Promise<string> {
  const registry = new InMemoryAgentRegistry();
  await registry.register("acme", AgentSpecSchema.parse(SPEC), "alice");
  return contentDigest(await registry.get("acme", "a1", "1.1.0"));
}

function proofFor(specDigest: string | undefined): CampaignAdoptionProof {
  return {
    campaignId: "camp-1",
    frameDigest: "sha256:frame",
    roundSeq: 2,
    candidate: {
      identity: specDigest === undefined ? "label_only" : "exact",
      type: "agent",
      id: "a1",
      version: "1.1.0",
      ...(specDigest !== undefined ? { specDigest } : {}),
    },
    provingScorecardId: "sc-cand",
    issueId: "iss-9",
    gateDigest: "sha256:gate",
  };
}

// One decided authorization, spendable once — the real store's shape.
function operations(proof: CampaignAdoptionProof) {
  let op: AdoptionOperation | undefined = {
    operationId: "adopt/acme/camp-1",
    tenant: "acme",
    proof,
    state: "decided",
    createdAt: "t",
    updatedAt: "t",
  };
  const registeredFacts: { message?: string; payload?: unknown; kind?: string }[] = [];
  const store: AdoptionOperationStore = {
    async forCampaign() {
      return op;
    },
    // The reconciler's worklist (arch-review 115). This double owns one operation and these cases drive the
    // adopt path directly, so it offers nothing to sweep.
    async registeredOlderThan() {
      return [];
    },
    async markRegistered(_t, _c, proofDigest, registeredVersion, events) {
      if (op === undefined) return "no_such_operation";
      if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
      if (op.state !== "decided") return "already_registered";
      op = { ...op, state: "registered", registeredVersion };
      for (const e of events ?? []) registeredFacts.push(e);
      return "registered";
    },
    // The completion half, answering the way the real store does — a double whose refusals are missing
    // makes a guard that rejects every real call read as a green test (rule `testing`).
    async forIssue(_t, issueId) {
      return op !== undefined && op.proof.issueId === issueId ? [op] : [];
    },
    // The scheduling write a sweep makes for a row it could not finish (arch-review 120). This test
    // drives the ADOPT path, which never sweeps — it is here because the port requires it, and a
    // double that lied about it would be answering a question this test does not ask.
    async deferCompletion() {
      throw new Error("the adopt path never reschedules a sweep");
    },
    async markCompleted(_t, _c, proofDigest) {
      if (op === undefined) return "no_such_operation";
      if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
      if (op.state === "completed") return "already_completed";
      if (op.state !== "registered") return "not_registered";
      op = { ...op, state: "completed" };
      return "completed";
    },
  };
  return { store, registeredFacts, current: () => op };
}

const candidateOf = (proof: CampaignAdoptionProof) => ({
  type: proof.candidate.type,
  id: proof.candidate.id,
  version: proof.candidate.version,
  ...(proof.candidate.specDigest !== undefined ? { specDigest: proof.candidate.specDigest } : {}),
});

describe("[R73 COUNTEREXAMPLE] a deployment can actually spend a campaign's authorization", () => {
  it("registers the adopted version and SPENDS the authorization, through the production wiring", async () => {
    const proof = proofFor(await measuredDigest());
    const { store, current } = operations(proof);
    const agents = new InMemoryAgentRegistry();

    const outcome = await buildCampaignAdoption({
      operations: store,
      agents,
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
      issues: openIssue(),
    }).adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof,
      candidate: candidateOf(proof),
      spec: SPEC,
      by: "alice",
      via: "web" as const,
    });

    expect(outcome.kind).toBe("adopted");
    // The EFFECT happened — the version is in the registry, not merely claimed.
    expect(await agents.has("acme", "a1", "1.1.0"), "the registry never received the adopted version").toBe(true);
    expect(current()?.state, "the authorization was never spent").toBe("registered");
    expect(current()?.registeredVersion).toBe("1.1.0");
  });

  // ── A REFUSAL AFTER AN IRREVERSIBLE WRITE IS NOT A REFUSAL (arch-review 76 P0) ────────────────────
  //
  // The C1-evaluated / C2-saved substitution, and the thing the first version got WRONG about it. It
  // registered, read back, and threw — the right answer at the wrong moment. Registry versions are
  // immutable, so the label already held C2 when the mismatch was found, and the honest retry that follows
  // is refused by immutability. Forever:
  //
  //     campaign adopted · operation decided · registry holds the wrong bytes · retry impossible
  //
  // The comment defending that ordering said "`decided` over a capability that exists is recoverable". It
  // is — when the capability is the right one. This is the half the first version did not assert: not just
  // that the adoption was refused, but that the WORLD is unchanged and the honest caller can still win.
  //
  // Seen RED before the pre-write proof, observed:
  //   a refused adoption left the wrong bytes at the label: expected true to be false
  it("REFUSES a substituted candidate WITHOUT touching the label, and the honest retry then succeeds", async () => {
    const proof = proofFor(await measuredDigest());
    const { store, current } = operations(proof);
    const agents = new InMemoryAgentRegistry();
    const service = buildCampaignAdoption({
      operations: store,
      agents,
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
      issues: openIssue(),
    });
    const request = {
      tenant: "acme",
      campaignId: "camp-1",
      proof,
      candidate: candidateOf(proof),
      by: "alice",
      via: "web" as const,
    };

    await expect(
      service.adopt({ ...request, spec: { ...SPEC, instructions: "a completely different agent" } }),
      "a substituted candidate was adopted under the measured version's label",
    ).rejects.toThrow(/nothing was registered/);
    expect(current()?.state, "the substitution spent the authorization anyway").toBe("decided");
    // …and the label is UNTOUCHED. This assertion is what makes the refusal mean something: an immutable
    // version poisoned by a rejected attempt can never be corrected.
    expect(await agents.has("acme", "a1", "1.1.0"), "a refused adoption left the wrong bytes at the label").toBe(false);

    // The honest caller then wins — impossible if the refusal happened after the write.
    const outcome = await service.adopt({ ...request, spec: SPEC });
    expect(outcome.kind, "the honest retry was refused by bytes a rejected attempt left behind").toBe("adopted");
    expect(current()?.state).toBe("registered");
  });

  it("REFUSES a spec that names a version this campaign did not authorize", async () => {
    const proof = proofFor(await measuredDigest());
    const { store, current } = operations(proof);

    await expect(
      buildCampaignAdoption({
        operations: store,
        agents: new InMemoryAgentRegistry(),
        harnesses: unusedHarnesses(),
        templates: unusedTemplates(),
        issues: openIssue(),
      }).adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof,
        candidate: candidateOf(proof),
        spec: { ...SPEC, version: "9.9.9" },
        by: "alice",
        via: "web" as const,
      }),
    ).rejects.toThrow(/authorized a1@1\.1\.0/);
    expect(current()?.state).toBe("decided");
  });

  it("converges on an at-least-once retry rather than adopting twice", async () => {
    // The registry write is idempotent by version, so re-driving after a crash between the effect and the
    // spend lands on the same row — which is why the effect goes first.
    const proof = proofFor(await measuredDigest());
    const { store } = operations(proof);
    const service = buildCampaignAdoption({
      operations: store,
      agents: new InMemoryAgentRegistry(),
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
      issues: openIssue(),
    });
    const request = {
      tenant: "acme",
      campaignId: "camp-1",
      proof,
      candidate: candidateOf(proof),
      spec: SPEC,
      by: "alice",
      via: "web" as const,
    };

    expect((await service.adopt(request)).kind).toBe("adopted");
    expect((await service.adopt(request)).kind, "a second consumer was granted its own adoption").toBe(
      "already_adopted",
    );
  });
});

// ── [R115] A `_shared` SHADOW IS A BIRTH, AND IT BELONGS TO THE CAMPAIGN'S TEAM ────────────────────
//
// `VersionedStore.has()` resolves through the `_shared` fallback, so a candidate that exists only there
// answered TRUE while this closure went on to create the workspace's FIRST local version — the fact said
// `created: false` about a version being born. The harness lane already used `ownVersions` (tenant-local,
// "no fallback — for conflict checks"): one fact, two lanes, two meanings.
//
// The same asymmetry decided OWNERSHIP. The owner lookup is tenant-local, so a `_shared`-only candidate had
// no owner to preserve and its first local version was born UNOWNED — a private team's campaign minting a
// capability every other team can see and write.
//
// Seen RED on the previous closure: `existed` was true (created: false) and `teamOfVersion` was undefined.
describe("[R115 COUNTEREXAMPLE] adopting a candidate that lives only in _shared", () => {
  it("reports the workspace version as CREATED and files it under the campaign's team", async () => {
    const proof = { ...proofFor(await measuredDigest()), teamId: "team-a" };
    const { store, registeredFacts } = operations(proof);
    const agents = new InMemoryAgentRegistry();
    // The candidate exists in `_shared` only — `has()` answers true for it, `ownVersions` does not.
    await agents.register("_shared", SPEC as never, "platform");
    expect(await agents.has("acme", proof.candidate.id, proof.candidate.version)).toBe(true);
    expect(await agents.ownVersions("acme", proof.candidate.id)).toEqual([]);

    const outcome = await buildCampaignAdoption({
      operations: store,
      agents,
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
      issues: openIssue(),
    }).adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof,
      candidate: candidateOf(proof),
      spec: SPEC,
      by: "alice",
      via: "web" as const,
      // The gate authorized an entity with no LOCAL owner, which is a claim, not an absence of one.
      expectedOwnerTeamId: undefined,
    });

    expect(outcome.kind).toBe("adopted");
    expect(
      await agents.teamOfVersion("acme", proof.candidate.id, proof.candidate.version),
      "a private team's campaign minted a capability owned by nobody",
    ).toBe("team-a");
    // …and the fact says a version was BORN, because one was. `has()` would have reported it as merely
    // proved, which is what an operator's audit reads.
    const born = registeredFacts.find((f) => f.kind === "campaign.adoption_registered");
    expect(born, "the registration emitted no fact to check").toBeDefined();
    expect(
      (born?.payload as { created?: boolean } | undefined)?.created,
      "a workspace version was created and reported as already existing",
    ).toBe(true);
  });
});

// ── [R115] A REFUSED OWNER LEAVES THE AUTHORIZATION UNSPENT ────────────────────────────────────────
//
// `owner_moved` is a refusal, and a refusal that spent the authorization would be worse than no check: the
// campaign could never be adopted again, by anybody, because the operation is single-use. The effect runs
// BEFORE `markRegistered` for exactly this reason (arch-review 72), so the assertion is about the WORLD —
// the operation is still `decided` and the honest retry, once the caller re-reads the owner, still works.
describe("[R115 COUNTEREXAMPLE] a refused adoption can still be adopted", () => {
  it("leaves the operation DECIDED and lets the corrected retry through", async () => {
    const proof = proofFor(await measuredDigest());
    const { store, current } = operations(proof);
    const agents = new InMemoryAgentRegistry();
    // The entity is team-b's NOW. The caller's gate saw team-a — which is the whole point: the two reads
    // disagree, and only the write can tell.
    //
    // ⚠️ Registered directly under team-b rather than "moved": `AgentRegistry` has no `moveToTeam`, which is
    // exactly what R77's own counterexample says (an optional call to a method that does not exist is a
    // silent no-op, so it drives the transfer through the store instead). A fixture calling one here would
    // have thrown rather than measured.
    await agents.register("acme", { ...SPEC, version: "1.0.0" } as never, "alice", "team-b");

    const service = buildCampaignAdoption({
      operations: store,
      agents,
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
      issues: openIssue(),
    });
    const request = {
      tenant: "acme",
      campaignId: "camp-1",
      proof,
      candidate: candidateOf(proof),
      spec: SPEC,
      by: "alice",
      via: "web" as const,
    };

    // A CONFLICT naming the transfer — not whatever the next step happens to fail with. Without the
    // refusal the store still writes nothing (that is the registry's guarantee), so the caller instead hits
    // the read-back and gets `Harness a1@1.1.0 not found` from version resolution: a real failure, about the
    // wrong thing, that reads as a broken adoption rather than a stale authorization. The registry keeps the
    // WRITE honest; this keeps the ANSWER honest.
    await expect(
      service.adopt({ ...request, expectedOwnerTeamId: "team-a" }),
      "a stale authorization was accepted",
    ).rejects.toThrow(/changed teams/);
    expect(current()?.state, "a refused adoption spent its authorization").toBe("decided");

    // …and the caller, having re-read the owner, adopts.
    expect((await service.adopt({ ...request, expectedOwnerTeamId: "team-b" })).kind).toBe("adopted");
  });
});

// The harness lane is not exercised here: a harness instance resolves through a TEMPLATE, so a fixture for
// it would have to seed a taxonomy — and a double that skipped that would be testing a resolution the
// production registry does not perform. The agent lane drives the same closure, the same read-back and the
// same comparison; the harness branch differs only in which registry it asks.
function unusedHarnesses() {
  return {
    async register() {
      throw new Error("the harness lane is not exercised by these cases");
    },
    async get() {
      throw new Error("the harness lane is not exercised by these cases");
    },
  } as unknown as Parameters<typeof buildCampaignAdoption>[0]["harnesses"];
}

// The template half, unexercised for the same reason the harness lane is: resolving one needs a seeded
// taxonomy, and a double that skipped that would be testing a resolution production does not perform.
function unusedTemplates() {
  return {
    async get() {
      throw new Error("the harness lane is not exercised by these cases");
    },
  } as unknown as Parameters<typeof buildCampaignAdoption>[0]["templates"];
}

// An issue nobody has resolved — the ordinary case, and the one that leaves the completion join to the
// watcher. The cases that exercise the REVERSE ordering supply their own resolved issue.
function openIssue() {
  return {
    async get() {
      return { status: "in_progress" as const };
    },
  };
}
