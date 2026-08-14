import { InMemoryCaseReceiptStore, ScorecardService, analysisRevisionKey } from "@everdict/application-control";
import type { JudgeSpec } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { InMemoryDatasetRegistry, InMemoryJudgeRegistry } from "@everdict/registry";
import { InMemoryArtifactStore } from "@everdict/storage";
import { describe, expect, it } from "vitest";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-41.
//
// HISTORICAL JUDGMENT IS RE-DERIVABLE, NOT MERELY DETECTABLE. The scoring ledger made a rewritten plane
// detectable (digests disagree), but every pass overwrote the ONE analysis artifact — so revision 1's
// analysisRef pointed at a file holding revision 3's content: the ledger said "this judgment existed" while
// serving a different judgment as its evidence. Each pass now freezes its bundle under an immutable key of
// its own. Certified through the production pipeline (submit → settle → score → score again): every
// revision's frozen artifact is DISTINCT, an earlier revision's bytes survive later passes unchanged, the
// read path serves exactly the requested revision, and a revision that never existed reads 404 — the current
// bundle is never dressed up as history.
//
// The certificate asserts the LEDGER'S OWN key, never a key shape it derives itself. This is the correction
// arch-review 10 forced: the artifact key moved from revision-scoped to PASS-scoped (two passes legitimately
// target the same revision number and freeze before the CAS decides which settles, and an object store has
// no compare-and-swap — a revision-keyed write let the loser's bytes land under the winner's revision). The
// invariant never changed; only the addressing did. A certificate that re-derives an address is certifying
// the scheme rather than the guarantee, and it went red on a change that strengthened the very property it
// exists to protect. `ScoringRevision.analysisKey` is where the ledger records where its own bundle lives,
// so that is what a reader — and this certificate — must follow.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

describeTrust("TRUST-41 — per-revision analysis artifacts are distinct, immutable, and honestly addressed", () => {
  it("three passes leave three frozen artifacts; re-reading an old revision returns ITS plane, forever", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    } as unknown as JudgeSpec);
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const artifacts = new InMemoryArtifactStore();
    let verdict = 1; // the judge's answer per pass — flips between passes so each revision's plane differs
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job) {
          return {
            caseId: job.evalCase.id,
            harness: `${job.harness.id}@${job.harness.version}`,
            trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }],
            snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
            scores: [],
          };
        },
      },
      store,
      runStore,
      caseReceipts: new InMemoryCaseReceiptStore(),
      datasets,
      judges,
      judgeRunner: {
        run: async (spec) => [
          { graderId: `judge:${spec.id}`, metric: `judge:${spec.id}`, value: verdict, pass: verdict === 1 },
        ],
      },
      artifacts,
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "hi" },
    });
    const waitRevisions = async (n: number) => {
      for (let i = 0; i < 300; i++) {
        const rec = await store.get(record.id);
        if ((rec?.scoring?.length ?? 0) >= n && (rec?.scoringPass ?? undefined) === undefined) return rec;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`revision ${n} did not settle`);
    };
    await waitRevisions(1); // the initial settle froze revision 1 (no judge scores yet)

    // Pass 2 judges PASS; pass 3 re-judges the same judge as FAIL — two more frozen planes.
    await service.scoreGroup({ tenant: "acme", id: record.id, judges: [{ id: "quality", version: "latest" }] });
    await waitRevisions(2);
    verdict = 0;
    await service.scoreGroup({ tenant: "acme", id: record.id, judges: [{ id: "quality", version: "latest" }] });
    const final = await waitRevisions(3);

    // Every revision entry points at its OWN frozen key, and all three artifacts exist side by side. Read
    // from the LEDGER (`analysisKey`) rather than re-derived: the ledger is the only thing that knows where a
    // revision's bundle lives, which is exactly why it records it.
    expect(final?.scoring?.map((rev) => rev.revision)).toEqual([1, 2, 3]);
    const keys = (final?.scoring ?? []).map((rev) => rev.analysisKey);
    expect(keys.filter((k) => typeof k === "string")).toHaveLength(3); // no revision left unaddressed
    expect(new Set(keys).size).toBe(3); // …and no two revisions share an address
    for (const [i, key] of keys.entries()) {
      expect(key).toBeDefined();
      expect(artifacts.objects.has(key as string)).toBe(true);
      // The ref the entry serves resolves to that same object — a ref pointing somewhere else is precisely
      // the "ledger says X, evidence is Y" failure this certificate exists to refuse.
      expect(final?.scoring?.[i]?.analysisRef).toContain(key as string);
    }

    // The frozen planes are DISTINCT and each one is the judgment of ITS pass — read back through the
    // production read path, after two later passes rewrote the live plane.
    const judgeRows = (bundle: unknown): Array<{ metric: string; value?: number }> =>
      (bundle as { cases: Array<{ scores: Array<{ metric: string; value?: number }> }> }).cases.flatMap((c) =>
        c.scores.filter((s) => s.metric === "judge:quality"),
      );
    expect(judgeRows(await service.analysisBundle("acme", record.id, undefined, 1))).toHaveLength(0);
    expect(judgeRows(await service.analysisBundle("acme", record.id, undefined, 2))).toEqual([
      { metric: "judge:quality", value: 1, graderId: "judge:quality", pass: true } as never,
    ]);
    expect(judgeRows(await service.analysisBundle("acme", record.id, undefined, 3))[0]).toMatchObject({ value: 0 });
    // The CURRENT bundle is the latest pass — same content as revision 3, different address.
    expect(judgeRows(await service.analysisBundle("acme", record.id))[0]).toMatchObject({ value: 0 });

    // A revision the ledger never appended reads 404 — never a silent fallback to the current bundle.
    await expect(service.analysisBundle("acme", record.id, undefined, 99)).rejects.toBeInstanceOf(NotFoundError);
  });
});
