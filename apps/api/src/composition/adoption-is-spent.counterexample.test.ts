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
    // The completion half, answering the way the real store does — a double whose refusals are missing
    // makes a guard that rejects every real call read as a green test (rule `testing`).
    async forIssue(_t, issueId) {
      return op !== undefined && op.proof.issueId === issueId ? [op] : [];
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
  return { store, current: () => op };
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

  it("REFUSES to spend when the registry would hold bytes the campaign never measured", async () => {
    // The C1-evaluated / C2-saved substitution, at the seam that performs the effect. The proof names one
    // document and the caller submits another under the same label.
    const proof = proofFor(await measuredDigest());
    const { store, current } = operations(proof);
    const agents = new InMemoryAgentRegistry();

    await expect(
      buildCampaignAdoption({ operations: store, agents, harnesses: unusedHarnesses() }).adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof,
        candidate: candidateOf(proof),
        spec: { ...SPEC, instructions: "a completely different agent" },
        by: "alice",
        via: "web" as const,
      }),
      "a substituted candidate was adopted under the measured version's label",
    ).rejects.toThrow();
    expect(current()?.state, "the substitution spent the authorization anyway").toBe("decided");
  });

  it("REFUSES a spec that names a version this campaign did not authorize", async () => {
    const proof = proofFor(await measuredDigest());
    const { store, current } = operations(proof);

    await expect(
      buildCampaignAdoption({
        operations: store,
        agents: new InMemoryAgentRegistry(),
        harnesses: unusedHarnesses(),
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
