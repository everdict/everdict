import { InMemoryCaseReceiptStore, ScorecardService, settleRun } from "@everdict/application-control";
import type { CaseCommitReceipt, CaseJob, CaseResult, RunRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { Run, caseResultDigest } from "@everdict/domain";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-174.
//
// MODEL-BASED CERTIFICATION: the pointwise scenarios each pin one discovered race; this explores the
// cross-product. Two halves:
//
//   ① a store-level model — two drivers race the atomic commit over one case across a takeover, in every
//     interleaving a seeded PRNG produces. The invariants are absolute: at most one receipt per
//     (scorecard, case, trial); a receipt's child is terminal and carries the receipt's bytes; a driver
//     whose parent epoch was superseded commits nothing.
//   ② a service-level fuzz — the REAL ScorecardService under a dispatcher that randomly succeeds, throws or
//     delays, with a mid-flight resume() racing the in-process driver. Whatever interleaving falls out, a
//     terminal batch must satisfy the ledger invariants (every counted outcome receipt-traced, every receipt
//     naming a terminal child with matching bytes, the decision context describing exactly the ledger).
//
// Determinism: mulberry32 over fixed seeds — a red run names its seed, so a failure replays exactly.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const resultOf = (caseId: string, value: number): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [{ metric: "pass", graderId: "g", value, pass: value > 0 }],
});

describeTrust("TRUST-174 ① — two drivers, one case, every interleaving: the commit invariants hold", () => {
  it("across 200 seeded interleavings of commit/commit/takeover, exactly one receipt survives and it names a terminal child with its own bytes", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);
      const receipts = new InMemoryCaseReceiptStore();
      const scorecards = new InMemoryScorecardStore();
      const runs = new InMemoryRunStore();
      runs.attachScorecards(scorecards);
      // The batch record whose ownerEpoch is the parent fence. Driver A holds epoch 1; a takeover mints 2 for B.
      await scorecards.create({
        id: "sc",
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        status: "running",
        ownerEpoch: 1,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      } as never);
      const child = (id: string): RunRecord =>
        ({
          id,
          tenant: "acme",
          harness: { id: "h", version: "1" },
          caseId: "c1",
          status: "running",
          parentScorecardId: "sc",
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        }) as RunRecord;
      await runs.create(child("child-A"));
      await runs.create(child("child-B"));
      const results = { "child-A": resultOf("c1", 1), "child-B": resultOf("c1", 0) } as const;

      const commitAs = async (childId: "child-A" | "child-B", epoch: number): Promise<void> => {
        const receipt: CaseCommitReceipt = {
          scorecardId: "sc",
          caseId: "c1",
          trial: 0,
          childRunId: childId,
          resultDigest: caseResultDigest(results[childId]),
          committedAt: "2026-08-14T00:00:01.000Z",
        };
        await receipts.commitCase(
          receipt,
          async (r) => {
            const cur = await r.get(childId);
            if (!cur || Run.from(cur).isTerminal()) return undefined;
            return settleRun(
              r,
              childId,
              Run.from(cur).succeed(results[childId], "2026-08-14T00:00:02.000Z").patch,
              undefined,
              {
                epoch: cur.ownerEpoch ?? 0,
                parentDriver: { scorecardId: "sc", epoch },
              },
            );
          },
          runs,
        );
      };
      const takeover = async (): Promise<void> => {
        await scorecards.update("sc", { updatedAt: "2026-08-14T00:00:01.500Z" }, undefined, { claimOwnership: true });
      };

      // Random interleaving: A commits under epoch 1; a takeover may or may not land first; B commits under
      // epoch 2 (the takeover's number) — B before its takeover models a driver acting on an epoch it has
      // not won, which the fence must refuse.
      const ops: Array<() => Promise<void>> = [() => commitAs("child-A", 1), takeover, () => commitAs("child-B", 2)];
      // Fisher–Yates under the seed.
      for (let i = ops.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const a = ops[i] as () => Promise<void>;
        ops[i] = ops[j] as () => Promise<void>;
        ops[j] = a;
      }
      // Half the seeds interleave concurrently (the mutex is the guarantee), half run sequentially.
      if (rand() < 0.5) await Promise.all(ops.map((op) => op()));
      else for (const op of ops) await op();

      // ── the absolute invariants ──
      const committed = await receipts.list("sc");
      expect(committed.length, `seed ${seed}: at most one receipt per (case, trial)`).toBeLessThanOrEqual(1);
      for (const r of committed) {
        const row = await runs.get(r.childRunId);
        expect(row && Run.from(row).isTerminal(), `seed ${seed}: a receipt's child is terminal`).toBe(true);
        expect(row?.result && caseResultDigest(row.result), `seed ${seed}: the child carries the receipt's bytes`).toBe(
          r.resultDigest,
        );
      }
      // A child that settled without the claim would be a canonical-looking row nobody committed — the
      // succeeded child must be exactly the receipt's, and the loser must not be succeeded.
      const succeeded = (
        await Promise.all(
          ["child-A", "child-B"].map(async (id) => ((await runs.get(id))?.status === "succeeded" ? id : undefined)),
        )
      ).filter((id): id is string => id !== undefined);
      expect(succeeded.length, `seed ${seed}: a terminal success exists only under a claim`).toBe(committed.length);
      if (committed[0]) expect(succeeded).toEqual([committed[0].childRunId]);
    }
  }, 60_000);
});

describeTrust("TRUST-174 ② — the real service under a random world: a terminal batch satisfies the ledger", () => {
  it("random dispatcher outcomes + a mid-flight resume never produce a settled batch the ledger does not vouch for", async () => {
    for (const seed of [3, 7, 11, 19, 23, 31, 41, 53, 67, 79]) {
      const rand = mulberry32(seed);
      const datasets = new InMemoryDatasetRegistry();
      await datasets.register("acme", {
        id: "fuzz",
        version: "1.0.0",
        tags: [],
        cases: ["c1", "c2", "c3"].map((id) => ({
          id,
          env: { kind: "prompt" as const },
          task: "t",
          graders: [],
          timeoutSec: 60,
          tags: [],
        })),
      });
      const receipts = new InMemoryCaseReceiptStore();
      const store = new InMemoryScorecardStore();
      store.attachReceipts((id) => receipts.countFor(id));
      const runStore = new InMemoryRunStore();
      runStore.attachScorecards(store);
      const service = new ScorecardService({
        dispatcher: {
          async dispatch(job: CaseJob) {
            await new Promise((r) => setTimeout(r, Math.floor(rand() * 30)));
            if (rand() < 0.3) throw new Error(`sandbox died (seed ${seed})`);
            return resultOf(job.evalCase.id, rand() < 0.5 ? 1 : 0);
          },
        },
        store,
        runStore,
        datasets,
        caseReceipts: receipts,
        harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
      } as never);
      const record = await service.submit({
        tenant: "acme",
        dataset: { id: "fuzz", version: "1.0.0" },
        harness: { id: "h", version: "1.0.0" },
        createdBy: "u",
        concurrency: 2,
      } as never);
      // A mid-flight resume races the in-process driver — the takeover shape, driven through production code.
      if (rand() < 0.7) {
        await new Promise((r) => setTimeout(r, Math.floor(rand() * 25)));
        await service.resume(record.id).catch(() => {});
      }
      // Wait for the dust to settle: whichever driver won, the batch must reach a coherent state.
      const deadline = Date.now() + 15_000;
      let settled = await store.get(record.id);
      while (settled && !["succeeded", "failed", "cancelled", "superseded"].includes(settled.status)) {
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
        settled = await store.get(record.id);
      }
      if (!settled) throw new Error(`seed ${seed}: record vanished`);

      // ── the absolute invariants, whatever happened ──
      const committed = await receipts.list(record.id);
      const keys = committed.map((r) => `${r.caseId}#${r.trial}`);
      expect(new Set(keys).size, `seed ${seed}: at most one receipt per (case, trial)`).toBe(keys.length);
      for (const r of committed) {
        const child = await runStore.get(r.childRunId);
        expect(child && Run.from(child).isTerminal(), `seed ${seed}: receipt ⇒ terminal child`).toBe(true);
        if (child?.result)
          expect(caseResultDigest(child.result), `seed ${seed}: receipt ⇒ the child's own bytes`).toBe(r.resultDigest);
      }
      if (settled.status === "succeeded") {
        // A settled SUCCESS must be fully accounted: the frozen decision context describes EXACTLY this
        // ledger — same count (what the terminal write conditioned on), same rows, same bytes.
        const decision = settled.decision;
        if (!decision) throw new Error(`seed ${seed}: a succeeded batch must freeze its decision context`);
        expect(decision.receiptCount, `seed ${seed}: the decision context is the ledger's`).toBe(committed.length);
        const byKey = new Map(committed.map((r) => [`${r.caseId}#${r.trial}`, r] as const));
        expect(decision.cases.length, `seed ${seed}: one decision row per receipt`).toBe(committed.length);
        for (const c of decision.cases) {
          const receipt = byKey.get(`${c.caseId}#${c.trial}`);
          expect(receipt?.childRunId, `seed ${seed}: the decision names the receipt's child`).toBe(c.childRunId);
          expect(receipt?.resultDigest, `seed ${seed}: the decision carries the receipt's bytes`).toBe(c.resultDigest);
        }
      }
    }
  }, 120_000);
});
