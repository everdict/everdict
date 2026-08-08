import type { CaseResult, Dataset, ScorecardRecord, ScoringPass } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { Dispatcher } from "../ports/dispatcher.js";
import type { ScorecardStore, ScorecardUpdateGuard } from "../ports/scorecard-store.js";
import { ScorecardService } from "./scorecard-service.js";

// application-control cannot depend on @everdict/db (that would invert the cone) — a minimal port-shaped
// store stands in; the DATABASE-side guard semantics have their own certification (TRUST-39, real Postgres).
class FakeScorecardStore implements ScorecardStore {
  readonly cards = new Map<string, ScorecardRecord>();
  async create(record: ScorecardRecord): Promise<void> {
    this.cards.set(record.id, record);
  }
  async update(
    id: string,
    patch: Partial<ScorecardRecord>,
    _events?: unknown[],
    guard?: ScorecardUpdateGuard,
  ): Promise<ScorecardRecord | undefined> {
    const cur = this.cards.get(id);
    if (!cur) return undefined;
    if (guard?.expectScoringCount !== undefined && (cur.scoring?.length ?? 0) !== guard.expectScoringCount)
      return undefined;
    if (guard?.expectGatesCount !== undefined && (cur.gates?.length ?? 0) !== guard.expectGatesCount) return undefined;
    const next = { ...cur, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete (next as Record<string, unknown>)[k];
    this.cards.set(id, next as ScorecardRecord);
    return this.cards.get(id);
  }
  async get(id: string): Promise<ScorecardRecord | undefined> {
    return this.cards.get(id);
  }
  async list(): Promise<ScorecardRecord[]> {
    return [...this.cards.values()];
  }
  async delete(id: string): Promise<boolean> {
    return this.cards.delete(id);
  }
}

const unusedDatasets = {
  async get(): Promise<Dataset> {
    throw new Error("datasets are not consulted by diff/gate");
  },
} as unknown as DatasetRegistry;

// Trust suite (docs/trust-certification.md) — TRUST-38.
//
// A TRUST READER NEVER READS A PLANE BETWEEN REVISIONS, AND A GATE PINS EXACTLY THE REVISION IT DIFFED.
// A scoring pass legally mutates the score plane in place (strip → re-judge → settle); the persisted pass
// marker (ScorecardRecord.scoringPass, mig 0147) is what makes that boundary VISIBLE state instead of a
// timing accident. Certified here through the production analytics: (1) a diff refuses a side whose marker
// is live, and keeps refusing when the marker says FAILED (an abandoned pass's half-stripped plane is not
// readable evidence — Temporal's score workflow has no compensation path, so the marker is the only thing
// standing between a dead pass and a silent half-judgment); (2) the gate's decision pins come from the ONE
// read the diff actually used — a re-score racing between the diff read and the decision write cannot move
// the pin onto a revision the decision never saw (the refetch TOCTOU).
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const scored = (caseId: string, pass: boolean): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
});

const succeeded = (id: string, results: CaseResult[], over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded",
  scorecard: { suiteId: "d@1.0.0", harness: "h@1", results },
  scoring: [
    {
      revision: 1,
      kind: "initial",
      judges: [],
      scorePlaneDigest: `sha256:plane-${id}`,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const dispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("never dispatches");
  },
};

describeTrust("TRUST-38 — the revision boundary is visible state, and the gate pins the read it decided on", () => {
  it("a live pass marker refuses the diff; a FAILED marker keeps refusing (abandoned evidence never reads)", async () => {
    const store = new FakeScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets: unusedDatasets });
    const pass: ScoringPass = {
      targetRevision: 2,
      baseRevision: 1,
      judges: [{ id: "quality", version: "1.0.0" }],
      startedAt: "2026-08-01T01:00:00.000Z",
      status: "running",
    };
    await store.create(succeeded("base", [scored("a", true)]));
    await store.create(succeeded("cand", [scored("a", true)], { scoringPass: pass }));

    await expect(service.diff("acme", "base", "cand")).rejects.toThrow(/between revisions/);
    // The pass dies mid-plane — the marker flips to failed and STAYS. The plane is still not evidence.
    await store.update("cand", { scoringPass: { ...pass, status: "failed", failure: "worker died" } });
    await expect(service.diff("acme", "base", "cand")).rejects.toThrow(/ABANDONED/);
    // Settling clears the marker in the same write shape production uses — the boundary closes, reads resume.
    await store.update("cand", { scoringPass: null });
    await expect(service.diff("acme", "base", "cand")).resolves.toBeDefined();
  });

  it("a re-score landing between the diff read and the decision write cannot move the gate's pin", async () => {
    const store = new FakeScorecardStore();
    // Sabotage: the SECOND read of the candidate (any refetch after the diff's own) sees revision 2. If the
    // gate refetched to pin, this walks the pin onto a judgment the decision never diffed.
    let candReads = 0;
    const originalGet = store.get.bind(store);
    store.get = async (id: string) => {
      const rec = await originalGet(id);
      if (rec && id === "cand") {
        candReads += 1;
        if (candReads > 1 && rec.scoring?.length === 1) {
          return {
            ...rec,
            scoring: [
              ...rec.scoring,
              {
                revision: 2,
                kind: "rescore" as const,
                judges: [],
                scorePlaneDigest: "sha256:plane-RESCORED",
                createdAt: "2026-08-01T02:00:00.000Z",
              },
            ],
          };
        }
      }
      return rec;
    };
    const service = new ScorecardService({ dispatcher, store, datasets: unusedDatasets });
    await store.create(succeeded("base", [scored("a", true)]));
    await store.create(succeeded("cand", [scored("a", true)]));

    const decision = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand", decidedBy: "ci" });
    // The pin is the revision the diff READ — revision 1 — whatever later reads would have shown.
    expect(decision.candidateScoring).toEqual({ revision: 1, scorePlaneDigest: "sha256:plane-cand" });
    expect(decision.baselineScoring).toEqual({ revision: 1, scorePlaneDigest: "sha256:plane-base" });
  });
});
