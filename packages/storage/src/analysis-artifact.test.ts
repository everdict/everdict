import {
  type AnalysisBundle,
  type ArtifactStore,
  analysisBundle,
  offloadAnalysis,
} from "@everdict/application-control";
import type { CaseResult, EnvSnapshot } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "./artifact-store.js";

// The analysis result as a first-class object: the aggregate summary + per-case verdict/scores, offloaded to the
// object store at finalize → ScorecardRecord.analysisRef (the analysis-output sibling of the run-output snapshots).
describe("analysisBundle + offloadAnalysis (analysis result → object storage)", () => {
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

  it("offloads the bundle to the store as application/json → a downloadable ref, bytes recoverable", async () => {
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    const ref = await offloadAnalysis({ artifacts: store }, "sc1", bundle);
    expect(ref).toBe("memory://artifacts/analyses/sc1.json");
    const stored = store.objects.get("analyses/sc1.json");
    expect(stored?.contentType).toBe("application/json");
    // the FULL analysis is stored (round-trips), not a truncated preview.
    const decoded = JSON.parse(Buffer.from(stored?.data ?? new Uint8Array()).toString()) as AnalysisBundle;
    expect(decoded).toEqual(bundle);
  });

  it("is best-effort: no store → undefined (dev fallback, never breaks the scorecard)", async () => {
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    expect(await offloadAnalysis({ artifacts: undefined }, "sc1", bundle)).toBeUndefined();
  });

  it("is best-effort: a store failure → undefined, swallowed (a broken object store never fails the eval)", async () => {
    const failing: ArtifactStore = {
      async put() {
        throw new Error("s3 down");
      },
    };
    const bundle = analysisBundle({ scorecardId: "sc1", dataset: "d@1", harness: "h@1" }, [], results);
    expect(await offloadAnalysis({ artifacts: failing }, "sc1", bundle)).toBeUndefined();
  });
});
