import type { AdoptionOperation, CampaignAdoptionProof } from "@everdict/contracts";
import { ConflictError, NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import { type CampaignAdoptionDeps, CampaignAdoptionService } from "./campaign-adoption-service.js";

type MergeDep = CampaignAdoptionDeps["merge"];

// ── THE CODE HALF OF AN ADOPTION IS SPENT LIKE THE BYTES HALF (code-evolution-loop.md, D5) ───────────
//
// An adoption registers the bytes a round measured; when they were built from a pull request the code is still
// a branch, and the close records that debt on the operation. `merge` pays it: the stored proof is the
// authority, the bytes must already be registered, the effect runs before the spend, and a retry converges.
// Each case below neutralizes one of those and shows what the loop would otherwise have been able to do.

const PROOF: CampaignAdoptionProof = {
  campaignId: "evc_1",
  frameDigest: "sha256:frame",
  roundSeq: 1,
  candidate: { identity: "exact", type: "harness", id: "scaffold", version: "1.0.1", specDigest: "sha256:spec" },
  provingScorecardId: "sc-cand",
  candidateSource: { source: "github-actions", repo: "acme/scaffold", sha: "abc123", prNumber: 7 },
  issueId: "iss_1",
  gateDigest: "sha256:gate",
};

// A minimal in-memory operation store carrying ONE operation, with the same conditional answers the real
// twins give — a double that always said "merged" would prove nothing (rule `testing`, guarded doubles).
function storeWith(
  initial: AdoptionOperation,
): AdoptionOperationStore & { events: OutboxEvent[]; current(): AdoptionOperation } {
  let op = initial;
  const events: OutboxEvent[] = [];
  return {
    events,
    current: () => op,
    async forCampaign(tenant, campaignId) {
      return tenant === op.tenant && campaignId === op.proof.campaignId ? op : undefined;
    },
    async markRegistered(_t, _c, digest, version, ev) {
      if (contentDigest(op.proof) !== digest) return "proof_mismatch";
      if (op.state !== "decided") return "already_registered";
      op = { ...op, state: "registered", registeredVersion: version };
      if (ev) events.push(...ev);
      return "registered";
    },
    async markMerged(_t, _c, digest, merged, ev) {
      if (contentDigest(op.proof) !== digest) return "proof_mismatch";
      if (op.code === undefined) return "no_code_debt";
      if (op.code.state === "merged") return "already_merged";
      if (op.state === "decided") return "not_registered";
      op = { ...op, code: { ...op.code, state: "merged", mergedSha: merged.sha, mergedAt: merged.at } };
      if (ev) events.push(...ev);
      return "merged";
    },
    async forIssue() {
      return [op];
    },
    async markCompleted() {
      return "not_registered";
    },
    async registeredOlderThan() {
      return [];
    },
    async deferCompletion() {
      return false;
    },
  };
}

const operation = (over: Partial<AdoptionOperation> = {}): AdoptionOperation => ({
  operationId: "adopt/acme/evc_1",
  tenant: "acme",
  proof: PROOF,
  state: "registered",
  code: { repo: "acme/scaffold", prNumber: 7, sha: "abc123", state: "owed" },
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...over,
});

const request = { tenant: "acme", campaignId: "evc_1", proof: PROOF, by: "alice", via: "web" as const };

function service(store: AdoptionOperationStore, merge: MergeDep) {
  return new CampaignAdoptionService({
    operations: store,
    issues: { get: async () => ({ status: "in_progress" }) },
    register: async () => {
      throw new Error("register is not exercised by these cases");
    },
    merge,
    now: () => "2026-09-02T03:00:00.000Z",
  });
}
// The effect double records what it was asked, so a case can assert the head the round measured travelled.
function mergeOf(
  answer: (input: { repo: string; prNumber: number; expectedSha?: string }) => Promise<{
    sha: string;
    alreadyMerged: boolean;
  }>,
): MergeDep & { calls: Array<{ repo: string; prNumber: number; expectedSha?: string }> } {
  const calls: Array<{ repo: string; prNumber: number; expectedSha?: string }> = [];
  const merge: MergeDep = async (input) => {
    calls.push({
      repo: input.repo,
      prNumber: input.prNumber,
      ...(input.expectedSha !== undefined ? { expectedSha: input.expectedSha } : {}),
    });
    return await answer(input);
  };
  return Object.assign(merge, { calls });
}

describe("[D5 COUNTEREXAMPLE] the code debt is paid by the effect, against the stored proof, after the bytes", () => {
  it("merges the pull request the STORED operation names, asserting the measured head, then records the commit and the fact", async () => {
    const store = storeWith(operation());
    const merge = mergeOf(async () => ({ sha: "m1", alreadyMerged: false }));
    const out = await service(store, merge).merge(request);
    expect(out).toMatchObject({ kind: "merged", sha: "m1" });
    expect(merge.calls).toEqual([{ repo: "acme/scaffold", prNumber: 7, expectedSha: "abc123" }]);
    expect(store.current().code).toMatchObject({ state: "merged", mergedSha: "m1" });
    expect(store.events.map((e) => e.kind)).toEqual(["campaign.adoption_merged"]);
    expect(store.events[0]?.payload).toMatchObject({
      repo: "acme/scaffold",
      prNumber: 7,
      mergedSha: "m1",
      version: "1.0.1",
    });
  });

  it("REFUSES a proof that is not the recorded one — a structurally similar proof is not authority", async () => {
    const store = storeWith(operation());
    const merge = mergeOf(async () => ({ sha: "m1", alreadyMerged: false }));
    const forged = { ...PROOF, candidateSource: { ...PROOF.candidateSource, prNumber: 8 } } as CampaignAdoptionProof;
    await expect(service(store, merge).merge({ ...request, proof: forged })).rejects.toBeInstanceOf(ConflictError);
    expect(merge.calls, "a forged proof reached the repository").toEqual([]);
    expect(store.current().code?.state).toBe("owed");
  });

  it("REFUSES before the bytes are registered — code is promoted only behind an adoption that landed", async () => {
    const store = storeWith(operation({ state: "decided" }));
    const merge = mergeOf(async () => ({ sha: "m1", alreadyMerged: false }));
    await expect(service(store, merge).merge(request)).rejects.toThrow(/not registered yet/);
    expect(merge.calls).toEqual([]);
  });

  it("REFUSES when the adoption carries no code debt — there is nothing to merge", async () => {
    const store = storeWith(operation({ code: undefined }));
    const merge = mergeOf(async () => ({ sha: "m1", alreadyMerged: false }));
    await expect(service(store, merge).merge(request)).rejects.toThrow(/no code debt/);
    expect(merge.calls).toEqual([]);
  });

  it("a merge that FAILS leaves the debt owed and writes no fact — the effect precedes the spend", async () => {
    const store = storeWith(operation());
    const merge = mergeOf(async () => {
      throw new ConflictError("CONFLICT", {}, "pull request #7's head moved after the round measured it");
    });
    await expect(service(store, merge).merge(request)).rejects.toThrow(/head moved/);
    expect(store.current().code?.state).toBe("owed");
    expect(store.events).toEqual([]);
  });

  it("a retry of a paid debt converges as already_merged without asking the repository again", async () => {
    const store = storeWith(
      operation({
        code: {
          repo: "acme/scaffold",
          prNumber: 7,
          sha: "abc123",
          state: "merged",
          mergedSha: "m1",
          mergedAt: "2026-09-02T02:00:00.000Z",
        },
      }),
    );
    const merge = mergeOf(async () => ({ sha: "m2", alreadyMerged: false }));
    const out = await service(store, merge).merge(request);
    expect(out).toMatchObject({ kind: "already_merged", sha: "m1" });
    expect(merge.calls).toEqual([]);
  });

  it("answers NOT FOUND for a campaign that never authorized an adoption", async () => {
    const store = storeWith(operation());
    const merge = mergeOf(async () => ({ sha: "m1", alreadyMerged: false }));
    await expect(service(store, merge).merge({ ...request, campaignId: "evc_ghost" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
