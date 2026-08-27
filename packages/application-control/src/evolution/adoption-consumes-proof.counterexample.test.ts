import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";
import { type CampaignAdoptionDeps, CampaignAdoptionService } from "./campaign-adoption-service.js";

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
    // The completion half, answering the way the real store does — a double that always succeeded would
    // make a guard that refuses every real call read as a green test (rule `testing`).
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

// The registry double answers with what it now HOLDS at that version — the read-back, not an echo of the
// caller's bytes. `holds` lets a case make the registry disagree with the proof without the write failing,
// which is the only way to reach the arch-review 73 check.
// ⚠️ `null`, not `undefined`, for "the registry resolves nothing": passing `undefined` explicitly SELECTS
// THE DEFAULT in JS, so the unresolvable case silently became the matching one and its test passed while
// never entering the branch. A double that is quietly more permissive than the real thing (rule `testing`).
// `lands` lets a case make the registry answer with an identity that is NOT the authorized one — the only
// way to reach the post-effect comparison (arch-review 75). Default: exactly what the proof authorized.
// Captures the facts that ride the spend — the E0 contract is that they land WITH the transition, so a
// double that dropped them would make the assertions above unfalsifiable.
function operationsWithFacts() {
  const built = operations();
  const seen: Array<{ kind: string; actor: string; causedBy?: string }> = [];
  const store: AdoptionOperationStore = {
    ...built.store,
    async markRegistered(t, c, digest, version, events) {
      for (const e of events ?? []) seen.push(e as unknown as { kind: string; actor: string; causedBy?: string });
      return built.store.markRegistered(t, c, digest, version);
    },
  };
  return { store, facts: () => seen, current: built.current };
}

const serviceOver = (
  store: AdoptionOperationStore,
  registered: string[],
  holds: string | null = "sha256:c1",
  lands: Partial<{ type: "agent" | "harness"; id: string; version: string }> = {},
) =>
  new CampaignAdoptionService({
    operations: store,
    // An issue nobody resolved — the ordinary path, which leaves the completion join to the watcher.
    issues: { get: async () => ({ status: "in_progress" }) },
    register: async ({ proof }) => {
      registered.push(proof.candidate.version);
      return {
        kind: "already_exists" as const,
        candidate: {
          type: proof.candidate.type,
          id: proof.candidate.id,
          version: proof.candidate.version,
          ...(holds !== null ? { specDigest: holds } : {}),
          ...lands,
        },
      };
    },
  });

// The registry double, typed rather than cast: `as never` on a constructed argument is what
// `pnpm constructed-casts` exists to refuse, and here it also erased the parameter types.
const landsAsAuthorized: CampaignAdoptionDeps["register"] = async ({ proof }) => ({
  kind: "already_exists",
  candidate: {
    type: proof.candidate.type,
    id: proof.candidate.id,
    version: proof.candidate.version,
    specDigest: "sha256:c1",
  },
});

// The bytes a caller submits. Opaque to the service by design — the digest that decides is the one the
// registry resolves, never a hash of this.
const SPEC = { id: "a1", instructions: "structure over phrasing" };

describe("[R72 COUNTEREXAMPLE] the registry effect spends the authorization it was given", () => {
  it("registers and SPENDS, once", async () => {
    const { store, current } = operations();
    const registered: string[] = [];

    const outcome = await serviceOver(store, registered).adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: PROOF,
      candidate: CANDIDATE,
      spec: SPEC,
      by: "alice",
      via: "web" as const,
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
        spec: SPEC,
        by: "alice",
        via: "web" as const,
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
        serviceOver(store, []).adopt({
          tenant: "acme",
          campaignId: "camp-1",
          proof: PROOF,
          candidate,
          spec: SPEC,
          by: "alice",
          via: "web" as const,
        }),
      ).rejects.toThrow(/different candidate/);
    }
  });

  it("REFUSES a proof the campaign never issued", async () => {
    const { store } = operations();
    const forged = { ...PROOF, gateDigest: "sha256:forged" };

    await expect(
      serviceOver(store, []).adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: forged,
        candidate: CANDIDATE,
        spec: SPEC,
        by: "alice",
        via: "web" as const,
      }),
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
      async forIssue() {
        return [];
      },
      async markCompleted() {
        return "no_such_operation";
      },
    };
    await expect(
      serviceOver(empty, []).adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: PROOF,
        candidate: CANDIDATE,
        spec: SPEC,
        by: "alice",
        via: "web" as const,
      }),
    ).rejects.toThrow(/never authorized an adoption/);
  });

  it("converges on an at-least-once retry rather than adopting twice", async () => {
    const { store } = operations();
    const registered: string[] = [];
    const svc = serviceOver(store, registered);

    await svc.adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: PROOF,
      candidate: CANDIDATE,
      spec: SPEC,
      by: "alice",
      via: "web" as const,
    });
    const second = await svc.adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: PROOF,
      candidate: CANDIDATE,
      spec: SPEC,
      by: "alice",
      via: "web" as const,
    });

    expect(second.kind, "a second consumer was granted its own adoption").toBe("already_adopted");
    expect(registered, "the effect ran twice for one authorization").toEqual(["1.1.0"]);
  });

  // ── WHAT THE REGISTRY NOW HOLDS IS CHECKED, NOT WHAT THE CALLER CLAIMED (arch-review 73) ──────────
  //
  // The coordinate comparison above is about the REQUEST. This is about the WORLD: the registry's own
  // document under the adopted label, digested after the write. Two reasons it is a separate check —
  //
  //   · a caller can present a correct proof and a correct coordinate triple and still register a document
  //     the campaign never measured, whenever the deployment's registry resolves a version through anything
  //     the caller does not fully supply (a harness template, a pin, a `_shared` fallback);
  //   · "the write did not throw" is not "the label points at these bytes" — immutability refuses a
  //     CHANGED version, and says nothing about one that was already there.
  //
  // Seen RED before the read-back, observed:
  //   an adoption was spent on a version the registry does not hold the measured bytes for: expected [Function] to throw
  it("REFUSES to spend when the registry resolves DIFFERENT bytes than the campaign measured", async () => {
    const { store, current } = operations();
    const registered: string[] = [];

    await expect(
      serviceOver(store, registered, "sha256:something-else").adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: PROOF,
        candidate: CANDIDATE,
        spec: SPEC,
        by: "alice",
        via: "web" as const,
      }),
      "an adoption was spent on a version the registry does not hold the measured bytes for",
    ).rejects.toThrow(/this campaign proved sha256:c1/);
    // …and it is the SPEND that is withheld, not the write: the effect ran, so the operation stays
    // `decided` over a capability that exists — the direction an operator can repair.
    expect(registered).toEqual(["1.1.0"]);
    expect(current()?.state, "a mismatched registration spent its authorization anyway").toBe("decided");
  });

  it("REFUSES to spend when the registry cannot resolve a document at all", async () => {
    // L2: "we could not find out" is not "it matched". A deployment whose registry answers nothing about
    // the adopted version has not confirmed the adoption — it has failed to check it.
    const { store, current } = operations();

    await expect(
      serviceOver(store, [], null).adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: PROOF,
        candidate: CANDIDATE,
        spec: SPEC,
        by: "alice",
        via: "web" as const,
      }),
    ).rejects.toThrow(/no resolvable document/);
    expect(current()?.state).toBe("decided");
  });

  it("SPENDS a label-only adoption the registry cannot digest", async () => {
    // The control, and the reason the check is conditional on the proof: a campaign that never named bytes
    // has nothing to compare, and refusing it would make `allowLabelOnlyAdoption` unusable. The weaker
    // adoption stays visible as the weaker one on the operation's own proof.
    // Built WITHOUT the digest rather than deleting it afterwards: a proof that never named bytes is a
    // different document, not one with a field removed.
    const { specDigest: _unnamed, ...withoutBytes } = PROOF.candidate;
    const labelOnly = { ...PROOF, candidate: { ...withoutBytes, identity: "label_only" as const } };
    const { store, current } = operations({ proof: labelOnly });

    const outcome = await serviceOver(store, [], null).adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: labelOnly,
      candidate: { type: "agent", id: "a1", version: "1.1.0" },
      spec: SPEC,
      by: "alice",
      via: "web" as const,
    });

    expect(outcome.kind).toBe("adopted");
    expect(current()?.state).toBe("registered");
  });

  it("REFUSES to spend when the registry landed a DIFFERENT VERSION than the proof authorized", async () => {
    // The defect a server-side-versioning door produces: `save_agent` auto patch-bumps a changed spec, so an
    // adapter bound to it answers 1.1.1 for a proof authorizing 1.1.0. The pre-effect comparison cannot see
    // that — it checks the REQUEST — and the first version recorded whatever came back, marking the
    // operation `registered` at a version the campaign never proved (arch-review 75 P1-high).
    //
    // Seen RED before the post-effect comparison, observed:
    //   registeredVersion recorded 1.1.1 for a proof authorizing 1.1.0
    const { store, current } = operations();

    await expect(
      serviceOver(store, [], "sha256:c1", { version: "1.1.1" }).adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: PROOF,
        candidate: CANDIDATE,
        spec: SPEC,
        by: "alice",
        via: "web" as const,
      }),
      "an auto-bumped version was recorded as the one this campaign proved",
    ).rejects.toThrow(/version 1\.1\.1 \(authorized: 1\.1\.0\)/);
    expect(current()?.state, "a drifted registration spent its authorization anyway").toBe("decided");
    expect(current()?.registeredVersion).toBeUndefined();
  });

  it("REFUSES to spend when the registry landed a different id or type", async () => {
    for (const lands of [{ id: "a2" }, { type: "harness" as const }]) {
      const { store, current } = operations();
      await expect(
        serviceOver(store, [], "sha256:c1", lands).adopt({
          tenant: "acme",
          campaignId: "camp-1",
          proof: PROOF,
          candidate: CANDIDATE,
          spec: SPEC,
          by: "alice",
          via: "web" as const,
        }),
      ).rejects.toThrow(/a different capability than this campaign authorized/);
      expect(current()?.state).toBe("decided");
    }
  });

  // ── THE ISSUE CAN CLOSE FIRST, AND THE JOIN STILL HAPPENS (arch-review 76 P1-high) ───────────────
  //
  // `adoptionCompletionWatch` owns `registered → issue done`. The reverse had NO owner: an issue resolved
  // BEFORE the registration landed produced one event, the watcher found the operation still `decided` and
  // skipped it, and the E1 cursor advanced. There is no second delivery of an event nobody rejected, so the
  // operation stayed `registered` forever.
  //
  // The watcher's comment claimed "the next delivery re-reads it" — a promise about a delivery that does not
  // exist. Whichever fact lands SECOND performs the join now, and this is the ordering nothing covered.
  //
  // Seen RED before the registration-side join, observed:
  //   an adoption whose issue had already closed on its evidence stayed registered: expected 'registered' to be 'completed'
  it("COMPLETES immediately when the issue had ALREADY resolved on this adoption's evidence", async () => {
    const { store, current } = operations();
    const service = new CampaignAdoptionService({
      operations: store,
      // The issue closed first — before anybody registered anything.
      issues: { get: async () => ({ status: "done", resolution: { scorecardId: "sc-cand" } }) },
      register: landsAsAuthorized,
    });

    const outcome = await service.adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: PROOF,
      candidate: CANDIDATE,
      spec: SPEC,
      by: "alice",
      via: "web" as const,
    });

    expect(outcome.kind).toBe("adopted");
    expect(current()?.state, "an adoption whose issue had already closed on its evidence stayed registered").toBe(
      "completed",
    );
  });

  it("stays REGISTERED when the issue closed on OTHER evidence, or is unreadable", async () => {
    // The same predicate the watcher uses, on this side of the join: a resolution that names a different
    // scorecard is not this adoption discharging its intent, and an unreadable issue is not an unresolved
    // one — both leave the operation owed rather than completed (L2/L3).
    for (const get of [
      async () => ({ status: "done", resolution: { scorecardId: "sc-something-else" } }),
      async () => ({ status: "in_progress" }),
      async () => {
        throw new Error("the tracker did not answer");
      },
    ]) {
      const { store, current } = operations();
      const service = new CampaignAdoptionService({
        operations: store,
        issues: { get },
        register: landsAsAuthorized,
      });

      const outcome = await service.adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: PROOF,
        candidate: CANDIDATE,
        spec: SPEC,
        by: "alice",
        via: "web" as const,
      });
      expect(outcome.kind, "an unreadable tracker failed an adoption that had already landed").toBe("adopted");
      expect(current()?.state).toBe("registered");
    }
  });

  // ── AN AGENT-CAUSED FACT CARRIES THE LOOP GUARD'S KEY (arch-review 85, rule `events`) ────────────
  //
  // `adopt_campaign_candidate` is an MCP tool, so the ordinary caller here IS an agent. Loop guard #1 keys
  // on the exact `agent:<id>:<conversation>` prefix to stop an agent waking on its own effects — a fact
  // emitted without it is one the guard cannot recognize, so the agent that adopted a candidate would be
  // woken by its own adoption and start the loop again.
  //
  // Seen RED before the attribution travelled, observed:
  //   the adoption fact carried no cause, so the agent that caused it will wake on it: expected undefined to be 'agent:a-7:conv-1'
  it("STAMPS the agent that adopted, so the guard can recognize its own effect", async () => {
    const { store, facts } = operationsWithFacts();

    await serviceOver(store, []).adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: PROOF,
      candidate: CANDIDATE,
      spec: SPEC,
      by: "u-1",
      via: "mcp" as const,
      agent: { agentId: "a-7", conversationId: "conv-1" },
    });

    const registered = facts().find((f) => f.kind === "campaign.adoption_registered");
    expect(registered, "the spend emitted no fact at all").toBeDefined();
    expect(
      registered?.causedBy,
      "the adoption fact carried no cause, so the agent that caused it will wake on it",
    ).toBe("agent:a-7:conv-1");
    // …and the actor stays the SUBJECT the agent acted for: `causedBy` says who caused it, `actor` says
    // whose authority it ran under, and collapsing them would lose one of the two.
    expect(registered?.actor).toBe("u-1");
  });

  it("stamps NOTHING when a member acted directly — an invented cause suppresses a real wakeup", async () => {
    const { store, facts } = operationsWithFacts();

    await serviceOver(store, []).adopt({
      tenant: "acme",
      campaignId: "camp-1",
      proof: PROOF,
      candidate: CANDIDATE,
      spec: SPEC,
      by: "u-1",
      via: "web" as const,
    });

    expect(facts().find((f) => f.kind === "campaign.adoption_registered")?.causedBy).toBeUndefined();
  });

  it("does NOT spend the authorization when the registry write fails", async () => {
    // The ordering that makes a crash recoverable: the effect first, the spend after. Spending first would
    // leave `registered` over a capability that does not exist — a lie no read can detect.
    const { store, current } = operations();
    const svc = new CampaignAdoptionService({
      operations: store,
      issues: { get: async () => ({ status: "in_progress" }) },
      register: async () => {
        throw new Error("the registry refused the write");
      },
    });

    await expect(
      svc.adopt({
        tenant: "acme",
        campaignId: "camp-1",
        proof: PROOF,
        candidate: CANDIDATE,
        spec: SPEC,
        by: "alice",
        via: "web" as const,
      }),
    ).rejects.toThrow(/refused the write/);
    expect(current()?.state, "a failed registration spent its authorization anyway").toBe("decided");
  });
});
