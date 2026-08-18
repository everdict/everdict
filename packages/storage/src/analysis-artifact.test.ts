import { type AnalysisBundle, type ArtifactStore, analysisBundle, stageAnalysis } from "@everdict/application-control";
import type { CaseResult, EnvSnapshot } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "./artifact-store.js";

// The analysis result as a first-class object: the aggregate summary + per-case verdict/scores, offloaded to the
// object store at finalize → ScorecardRecord.analysisRef (the analysis-output sibling of the run-output snapshots).
describe("analysisBundle + stageAnalysis (analysis result → object storage)", () => {
  const repoSnap: EnvSnapshot = { kind: "repo", diff: "", changedFiles: [], headSha: "h" };
  const failure = {
    stage: "grade",
    class: "agent",
    code: "GRADER_FAIL",
    message: "wrong answer",
    retryable: false,
  } as const;
  const passScore = { graderId: "tests", metric: "tests_pass", value: 1, pass: true } as const;
  const failScore = { graderId: "tests", metric: "tests_pass", value: 0, pass: false } as const;
  const results: CaseResult[] = [
    { caseId: "c1", harness: "h@1", trace: [], snapshot: repoSnap, scores: [passScore] },
    { caseId: "c2", harness: "h@1", trace: [], snapshot: repoSnap, scores: [failScore], failure },
  ];

  it("builds a self-contained bundle: dataset/harness + summary + per-case verdict/scores/failure", () => {
    const summary = [{ metric: "pass", mean: 0.5, count: 2 }];
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, summary, results);
    expect(bundle.scorecardId).toBe("sc1");
    expect(bundle.dataset).toBe("d@1");
    expect(bundle.harness).toBe("h@1");
    expect(bundle.summary).toEqual(summary);
    expect(bundle.cases).toHaveLength(2);
    expect(bundle.cases[0]).toEqual({ caseId: "c1", verdict: true, scores: [passScore] });
    // the failing case carries its verdict + the classified failure (the artifact is a defensible verdict on its own).
    expect(bundle.cases[1]?.verdict).toBe(false);
    expect(bundle.cases[1]?.failure).toEqual(failure);
  });

  // RE-POINTED AT `stageAnalysis` (arch-review 55, Wave 7). These pinned `offloadAnalysis`, which wrote the
  // MUTABLE `analyses/<id>.json` alias and had already lost its last production caller; it is deleted, and
  // every property below except the alias itself belongs to the staging seam that replaced it.
  it("stages the bundle as application/json under the PASS key → bytes recoverable, no mutable key touched", async () => {
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    const offload = await stageAnalysis({ artifacts: store }, "sc1", bundle, "pass-7");
    const stored = store.objects.get("analyses/sc1/passes/pass-7.json");
    expect(stored?.contentType).toBe("application/json");
    // the FULL analysis is stored (round-trips), not a truncated preview.
    const decoded = JSON.parse(Buffer.from(stored?.data ?? new Uint8Array()).toString()) as AnalysisBundle;
    expect(decoded).toEqual(bundle);
    expect(offload.revisionKey).toBe("analyses/sc1/passes/pass-7.json");
    // The alias is not written by ANY settle path any more — that is the whole point of the deletion.
    expect(store.objects.has("analyses/sc1.json")).toBe(false);
  });

  it("freezes the bundle under the PASS that wrote it, and reports the durable key", async () => {
    // The immutable history lane, keyed by pass rather than by revision (arch-review 8 P0): two passes can
    // target the SAME revision number and both freeze before the ledger CAS picks a winner, and an object
    // store has no compare-and-swap — a revision-keyed write let the loser's bytes land under the winner's
    // revision. The key is also REPORTED, because a presigned ref expires and the revision number no longer
    // names the object a historical read has to fetch.
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    const offload = await stageAnalysis({ artifacts: store }, "sc1", bundle, "pass-7");
    expect(offload.revisionRef).toBe("memory://artifacts/analyses/sc1/passes/pass-7.json");
    expect(offload.revisionKey).toBe("analyses/sc1/passes/pass-7.json");
    const frozen = store.objects.get("analyses/sc1/passes/pass-7.json");
    expect(frozen?.contentType).toBe("application/json");
    expect(JSON.parse(Buffer.from(frozen?.data ?? new Uint8Array()).toString())).toEqual(bundle);
  });

  it("two passes racing for one revision write DIFFERENT objects — the loser can never overwrite the winner", async () => {
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    const a = await stageAnalysis({ artifacts: store }, "sc1", bundle, "pass-A");
    const b = await stageAnalysis({ artifacts: store }, "sc1", bundle, "pass-B");
    expect(a.revisionKey).not.toBe(b.revisionKey);
    // Both objects survive: an abandoned pass's bundle is evidence of what it was doing, not garbage, and
    // the ledger entry that won points at its OWN key.
    expect(store.objects.has("analyses/sc1/passes/pass-A.json")).toBe(true);
    expect(store.objects.has("analyses/sc1/passes/pass-B.json")).toBe(true);
  });

  it("is best-effort: no store → no refs at all (dev fallback, never breaks the scorecard)", async () => {
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    expect(await stageAnalysis({ artifacts: undefined }, "sc1", bundle, "pass-7")).toEqual({});
  });

  it("is best-effort per key: a store failure → no ref, swallowed (a broken object store never fails the eval)", async () => {
    const failing: ArtifactStore = {
      async put() {
        throw new Error("s3 down");
      },
      async get() {
        return undefined;
      },
      async publicUrlFor() {
        return undefined;
      },
    };
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    expect(await stageAnalysis({ artifacts: failing }, "sc1", bundle, "pass-7")).toEqual({});
  });

  it("a pass-key failure leaves the entry honestly artifact-less — never a key to bytes that failed", async () => {
    const halfBroken: ArtifactStore = {
      async put(key: string) {
        if (key.includes("/passes/")) throw new Error("revision bucket down");
        return `memory://artifacts/${key}`;
      },
      async get() {
        return undefined;
      },
      async publicUrlFor() {
        return undefined;
      },
    };
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    const offload = await stageAnalysis({ artifacts: halfBroken }, "sc1", bundle, "pass-7");
    expect(offload.revisionRef).toBeUndefined();
    expect(offload.revisionKey).toBeUndefined(); // no key either — the entry must not point at bytes that failed
  });
});
