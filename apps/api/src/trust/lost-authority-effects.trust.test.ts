import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { InMemoryArtifactStore } from "@everdict/storage";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-161.
//
// A REVOKED DRIVER PUBLISHES NOTHING — asserted on the EFFECTS, not on the status.
//
// "First terminal write wins" was proved long ago, and it is a statement about one column. The driver that
// loses does far more than write a status: it offloads snapshots to object storage, exports the case traces
// and scores to the tenant's own observability platform, writes the analysis artifact, and writes results
// back onto the child rows. The final CAS refuses the status and none of that — an export cannot be
// un-sent, and an object under a logical key cannot be un-written.
//
// The previous shape marked an AbortController when a child settle came back `lost` and then continued down
// the same straight line, because an AbortController stops future DISPATCHES and nothing that is called
// directly on the next line. So the loser's export reached the tenant's platform, its analysis object
// overwrote the winner's under the same key, and the only thing it was actually denied was the row.
//
// The loss is staged the way it actually happens without a supersede: a CHILD is settled out from under the
// driver (a user cancelling one case, or a recovery that adopted it), so the batch's own authority check has
// nothing to notice and the driver walks into the settlement holding a full set of results it may not publish.
//
// What is asserted here is an ABSENCE, in the places a loser could still be heard from.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const CASES = ["c1", "c2", "c3"];

const result = (caseId: string): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  scores: [{ metric: "pass", graderId: "g", value: 1 }],
  snapshot: { kind: "prompt", output: "" },
});

describeTrust("TRUST-161 — a driver that lost its batch makes no external effect", () => {
  it("stops before export, analysis and write-back when a child settle comes back lost", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "three",
      version: "1.0.0",
      tags: [],
      cases: CASES.map((id) => ({
        id,
        env: { kind: "prompt" as const },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
    });
    const templates = new InMemoryHarnessTemplateRegistry();
    const harnesses = new InMemoryHarnessInstanceRegistry(templates);
    const store = new InMemoryScorecardStore();
    const backing = new InMemoryRunStore();
    const artifacts = new InMemoryArtifactStore();
    const exported: string[] = [];
    // The child of the LAST case is settled out from under this driver — a per-case cancel, or a recovery that
    // adopted it. The batch record is untouched, so the driver's own authority checks have nothing to notice:
    // it arrives at the settlement holding a complete set of results and only THEN learns the case is not its
    // to commit. A guarded write that loses returns nothing, which is what this stands in for.
    const runStore = new Proxy(backing, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver);
        return async (id: string, patch: unknown, events: unknown, opts: unknown): Promise<unknown> => {
          const current = await backing.get(id);
          const settlingLastCase =
            current?.caseId === CASES[CASES.length - 1] && (patch as { status?: string })?.status === "succeeded";
          if (settlingLastCase) return undefined; // someone else already ended this case
          return backing.update(id, patch as never, events as never, opts as never);
        };
      },
    });

    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          return result(job.evalCase.id);
        },
      },
      store,
      runStore,
      caseReceipts: new InMemoryCaseReceiptStore(),
      datasets,
      harnesses,
      artifacts,
      // The tenant's own platform. Anything that arrives here has left the building.
      exportResults: async (_tenant: string, _ctx: unknown, results: CaseResult[]) => {
        for (const r of results) exported.push(r.caseId);
        return { status: "ok" as const, cases: [] };
      },
    } as never);

    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "three", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);

    await new Promise((r) => setTimeout(r, 3000));

    // Nothing left the building: no case reached the tenant's platform…
    expect(exported).toEqual([]);
    // …and no analysis artifact was written under the batch's key, where the winner's would go — an object
    // store has no compare-and-set, so a loser's write simply replaces the bytes a reader will fetch.
    expect([...artifacts.objects.keys()].filter((k) => k.startsWith("analyses/"))).toEqual([]);
    // The batch is not this driver's to end, either — it did not stamp a failure on somebody else's record.
    const settled = await store.get(record.id);
    expect(settled?.status).not.toBe("failed");
  }, 20_000);
});
