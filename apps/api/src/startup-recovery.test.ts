import { InMemoryRunStore, InMemoryScorecardStore, type RunRecord, type ScorecardRecord } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { recoverInterrupted } from "./startup-recovery.js";

const card = (id: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "running",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  ...over,
});

const runRec = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "h", version: "1" },
  caseId: "c1",
  status: "running",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  ...over,
});

describe("recoverInterrupted (reclaim orphaned jobs at boot)", () => {
  it("finalizes queued/running batches, children, and standalone runs orphaned by a restart as INTERRUPTED", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await scorecards.create(card("zombie-running"));
    await scorecards.create(card("zombie-queued", { status: "queued" }));
    await scorecards.create(card("done", { status: "succeeded" }));
    // children of zombie-running: 1 finalized + 1 still running (orphan)
    await runs.create(runRec("child-done", { status: "succeeded", parentScorecardId: "zombie-running" }));
    await runs.create(runRec("child-stuck", { parentScorecardId: "zombie-running" }));
    // standalone: 1 orphan + 1 finalized
    await runs.create(runRec("solo-stuck"));
    await runs.create(runRec("solo-done", { status: "failed" }));

    const res = await recoverInterrupted({ scorecards, runs, now: () => "2026-07-04T00:00:00.000Z" });

    expect(res).toEqual({ scorecards: 2, resumed: 0, runs: 2, runsResumed: 0 });
    expect((await scorecards.get("zombie-running"))?.status).toBe("failed");
    expect((await scorecards.get("zombie-running"))?.error?.code).toBe("INTERRUPTED");
    expect((await scorecards.get("zombie-queued"))?.status).toBe("failed");
    expect((await scorecards.get("done"))?.status).toBe("succeeded"); // terminal status is left unchanged
    expect((await runs.get("child-stuck"))?.status).toBe("failed");
    expect((await runs.get("child-done"))?.status).toBe("succeeded");
    expect((await runs.get("solo-stuck"))?.status).toBe("failed");
    expect((await runs.get("solo-done"))?.error).toBeUndefined(); // does not overwrite the existing failed record
  });

  it("changes nothing when there are no orphans", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await scorecards.create(card("done", { status: "succeeded" }));
    expect(await recoverInterrupted({ scorecards, runs })).toEqual({
      scorecards: 0,
      resumed: 0,
      runs: 0,
      runsResumed: 0,
    });
  });

  it("resumes a resumable batch instead of tombstoning it — only unresumable ones fall back to INTERRUPTED", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await scorecards.create(card("resumable"));
    await scorecards.create(card("legacy")); // pre-orchestration record — resume() reports false
    const resumedIds: string[] = [];
    const res = await recoverInterrupted({
      scorecards,
      runs,
      resume: async (id) => {
        resumedIds.push(id);
        return id === "resumable";
      },
      now: () => "2026-07-04T00:00:00.000Z",
    });
    expect(res).toEqual({ scorecards: 1, resumed: 1, runs: 0, runsResumed: 0 });
    expect(resumedIds).toEqual(["resumable", "legacy"]);
    // The resumed batch is left alone (its own track loop drives the status); the legacy one is tombstoned.
    expect((await scorecards.get("resumable"))?.status).toBe("running");
    expect((await scorecards.get("legacy"))?.status).toBe("failed");
    expect((await scorecards.get("legacy"))?.error?.code).toBe("INTERRUPTED");
  });

  it("resumes a standalone run via resumeRun instead of tombstoning; legacy records still tombstone", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await runs.create(runRec("solo-durable")); // has a persisted caseSpec in real wiring
    await runs.create(runRec("solo-legacy")); // pre-0051 record — resumeRun reports false
    const attempted: string[] = [];
    const res = await recoverInterrupted({
      scorecards,
      runs,
      resumeRun: async (r) => {
        attempted.push(r.id);
        return r.id === "solo-durable";
      },
      now: () => "2026-07-04T00:00:00.000Z",
    });
    expect(res).toEqual({ scorecards: 0, resumed: 0, runs: 1, runsResumed: 1 });
    expect(attempted).toEqual(["solo-durable", "solo-legacy"]);
    // The resumed run is left alone (RunService.resume drives its status); the legacy one is tombstoned.
    expect((await runs.get("solo-durable"))?.status).toBe("running");
    expect((await runs.get("solo-legacy"))?.status).toBe("failed");
    expect((await runs.get("solo-legacy"))?.error?.code).toBe("INTERRUPTED");
  });

  it("a throwing resumeRun does not crash boot — that run tombstones like a legacy one", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await runs.create(runRec("solo-explodes"));
    const res = await recoverInterrupted({
      scorecards,
      runs,
      resumeRun: async () => {
        throw new Error("runtime registry gone");
      },
    });
    expect(res).toEqual({ scorecards: 0, resumed: 0, runs: 1, runsResumed: 0 });
    expect((await runs.get("solo-explodes"))?.status).toBe("failed");
  });

  it("a throwing resume() does not crash boot — that batch tombstones like an unresumable one", async () => {
    const scorecards = new InMemoryScorecardStore();
    await scorecards.create(card("explodes"));
    const res = await recoverInterrupted({
      scorecards,
      resume: async () => {
        throw new Error("dataset gone");
      },
    });
    expect(res).toEqual({ scorecards: 1, resumed: 0, runs: 0, runsResumed: 0 });
    expect((await scorecards.get("explodes"))?.status).toBe("failed");
  });
});
