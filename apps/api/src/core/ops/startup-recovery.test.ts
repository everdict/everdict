import { type ReplicaRegistry, recoverInterrupted } from "@everdict/application-control";
import { InMemoryRunStore, InMemoryScorecardStore, type RunRecord, type ScorecardRecord } from "@everdict/db";
import { describe, expect, it } from "vitest";

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

// A heartbeat set with the given replicas alive — what boot recovery reads to decide whether a record's
// owner is gone.
const aliveReplicas = (ids: string[]): ReplicaRegistry => ({
  async beat() {},
  async liveReplicas() {
    return ids;
  },
  async leave() {},
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

    expect(res).toEqual({ scorecards: 2, resumed: 0, runs: 2, runsResumed: 0, sessions: 0, live: 0 });
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
      sessions: 0,
      live: 0,
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
    expect(res).toEqual({ scorecards: 1, resumed: 1, runs: 0, runsResumed: 0, sessions: 0, live: 0 });
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
    expect(res).toEqual({ scorecards: 0, resumed: 0, runs: 1, runsResumed: 1, sessions: 0, live: 0 });
    expect(attempted).toEqual(["solo-durable", "solo-legacy"]);
    // The resumed run is left alone (RunService.resume drives its status); the legacy one is tombstoned.
    expect((await runs.get("solo-durable"))?.status).toBe("running");
    expect((await runs.get("solo-legacy"))?.status).toBe("failed");
    expect((await runs.get("solo-legacy"))?.error?.code).toBe("INTERRUPTED");
  });

  it("does not block startup on a slow adoption — resumeRun claims the run and backgrounds the work", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await runs.create(runRec("solo-running")); // a long-running run at restart
    let backgroundSettled = false;
    const res = await recoverInterrupted({
      scorecards,
      runs,
      // Mirrors main.ts: claim (return true) immediately, do the slow adopt/settle in the background.
      resumeRun: async () => {
        void new Promise((r) => setTimeout(r, 200)).then(() => {
          backgroundSettled = true;
        });
        return true;
      },
      now: () => "2026-07-09T00:00:00.000Z",
    });
    // Recovery returned promptly (before the 200ms background work) — startup is not blocked.
    expect(backgroundSettled).toBe(false);
    expect(res).toEqual({ scorecards: 0, resumed: 0, runs: 0, runsResumed: 1, sessions: 0, live: 0 });
    expect((await runs.get("solo-running"))?.status).toBe("running"); // claimed, not tombstoned
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
    expect(res).toEqual({ scorecards: 0, resumed: 0, runs: 1, runsResumed: 0, sessions: 0, live: 0 });
    expect((await runs.get("solo-explodes"))?.status).toBe("failed");
  });

  it("leaves session runs (kind sandbox) to their reapers — never tombstoned, never claimed for resume", async () => {
    // Regression: boot recovery used to hand session runs to resumeRun, whose claim-then-fail left them
    // `running` forever (no caseSpec to re-dispatch, no backend job to adopt — the live zombie class).
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await runs.create(
      runRec("session-orphan", {
        kind: "sandbox",
        lifetime: "session",
        trigger: "sandbox",
        session: { image: "debian:stable-slim", ttlSec: 300, expiresAt: "2026-07-03T00:05:00.000Z" },
      }),
    );
    await runs.create(runRec("solo-stuck"));
    const attempted: string[] = [];
    const res = await recoverInterrupted({
      scorecards,
      runs,
      resumeRun: async (r) => {
        attempted.push(r.id);
        return false;
      },
      now: () => "2026-07-04T00:00:00.000Z",
    });
    expect(res).toEqual({ scorecards: 0, resumed: 0, runs: 1, runsResumed: 0, sessions: 1, live: 0 });
    expect(attempted).toEqual(["solo-stuck"]); // the session run was never offered for resume
    expect((await runs.get("session-orphan"))?.status).toBe("running"); // its reaper/orphan sweep settles it
    expect((await runs.get("solo-stuck"))?.status).toBe("failed");
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
    expect(res).toEqual({ scorecards: 1, resumed: 0, runs: 0, runsResumed: 0, sessions: 0, live: 0 });
    expect((await scorecards.get("explodes"))?.status).toBe("failed");
  });
  // ── Multi-replica (docs/architecture/multi-replica.md) ────────────────────────────────────────────────
  // Pre-fix, recovery reclaimed every in-flight record it found, so booting a second replica tombstoned the
  // first one's live batches and runs mid-flight. These three pin the ownership check that stops it.

  it("leaves a batch and a run alone while the replica driving them is still heartbeating", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await scorecards.create(card("driven-elsewhere", { ownerReplica: "cp-alive" }));
    await runs.create(runRec("driven-elsewhere-run", { ownerReplica: "cp-alive" }));

    const res = await recoverInterrupted({
      scorecards,
      runs,
      owner: "cp-booting",
      replicas: aliveReplicas(["cp-alive"]),
      now: () => "2026-07-04T00:00:00.000Z",
    });

    expect(res.live).toBe(2);
    expect(res).toMatchObject({ scorecards: 0, runs: 0, resumed: 0, runsResumed: 0 });
    expect((await scorecards.get("driven-elsewhere"))?.status).toBe("running");
    expect((await runs.get("driven-elsewhere-run"))?.status).toBe("running");
  });

  it("reclaims what a DEAD replica left, and takes ownership so the next boot does not take it back", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await scorecards.create(card("dead-owner", { ownerReplica: "cp-crashed" }));
    await runs.create(runRec("dead-owner-run", { ownerReplica: "cp-crashed" }));
    await runs.create(runRec("unowned")); // a pre-column row: no owner, reclaimed as it always was

    const res = await recoverInterrupted({
      scorecards,
      runs,
      owner: "cp-booting",
      replicas: aliveReplicas(["cp-booting"]), // only we are alive
      resume: async () => true,
      now: () => "2026-07-04T00:00:00.000Z",
    });

    expect(res).toMatchObject({ resumed: 1, runs: 2, live: 0 });
    expect((await scorecards.get("dead-owner"))?.ownerReplica).toBe("cp-booting");
    expect((await runs.get("dead-owner-run"))?.status).toBe("failed");
    expect((await runs.get("unowned"))?.status).toBe("failed");
  });

  it("treats an unreadable heartbeat set as 'everyone may be alive' — it never reclaims on a database blip", async () => {
    const scorecards = new InMemoryScorecardStore();
    await scorecards.create(card("owned", { ownerReplica: "cp-other" }));

    const res = await recoverInterrupted({
      scorecards,
      owner: "cp-booting",
      replicas: {
        beat: async () => {},
        liveReplicas: async () => Promise.reject(new Error("db down")),
        leave: async () => {},
      },
      now: () => "2026-07-04T00:00:00.000Z",
    });

    expect(res.live).toBe(1);
    expect((await scorecards.get("owned"))?.status).toBe("running"); // fail-closed: a stale row beats a killed batch
  });
});
