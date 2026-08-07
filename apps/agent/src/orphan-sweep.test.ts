import type { AgentSessionRecord } from "@everdict/contracts";
import { InMemoryAgentSessionStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildOrphanSweeper } from "./orphan-sweep.js";
import type { AgentRunEventReport } from "./usage.js";

const BOOT = "2026-08-07T12:00:00.000Z";

function run(over: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    id: "sess-1",
    tenant: "acme",
    owner: "alice",
    title: "sentinel — scorecard.completed",
    visibility: "workspace",
    origin: {
      type: "trigger",
      agentId: "sentinel",
      agentVersion: "1.0.0",
      eventId: "ev-1",
      eventKind: "scorecard.completed",
    },
    status: "running",
    runId: "run-1",
    createdAt: "2026-08-07T11:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z", // stranded BEFORE this process booted
    ...over,
  };
}

function harness(opts?: {
  resume?: (input: { workspace: string; sessionId: string }) => Promise<{ resumed: boolean; reason?: string }>;
}) {
  const sessions = new InMemoryAgentSessionStore();
  const resumes: Array<{ workspace: string; sessionId: string }> = [];
  const reports: AgentRunEventReport[] = [];
  const sweeper = buildOrphanSweeper({
    sessions,
    bootAt: BOOT,
    now: () => "2026-08-07T12:00:01.000Z",
    resume:
      opts?.resume ??
      (async (input) => {
        resumes.push(input);
        return { resumed: true };
      }),
    reportRunEvent: async (input) => {
      reports.push(input);
    },
  });
  return { sessions, sweeper, resumes, reports };
}

describe("orphan-run sweep (P0 crash reconcile)", () => {
  it("a run stranded by a previous process death is claimed once and RESUMED on the same session", async () => {
    // Given a run left in "running" from before this process booted
    const { sessions, sweeper, resumes } = harness();
    await sessions.createSession(run({}));

    // When the boot sweep runs
    const claimed = await sweeper.sweep();

    // Then the stranded run was claimed and handed to the activator's continuation resume — the SAME session,
    // never a duplicate activation
    expect(claimed).toBe(1);
    expect(resumes).toEqual([{ workspace: "acme", sessionId: "sess-1" }]);
    // and the durable (agent, event) dedup still reads the pair as handled — recovery is resumption, so the
    // reconcile loop re-feeding the same event can never double-run it (the pre-fix bug: the orphan blocked
    // re-activation forever while nothing ever resumed it either)
    expect(await sessions.hasTriggerSession("acme", "sentinel", "ev-1")).toBe(true);
    // and a second pass finds nothing left to claim
    expect(await sweeper.sweep()).toBe(0);
  });

  it("a run started AFTER this process booted is never touched — it belongs to a live in-process activation", async () => {
    const { sessions, sweeper, resumes } = harness();
    await sessions.createSession(run({ id: "fresh", updatedAt: "2026-08-07T12:30:00.000Z" }));
    expect(await sweeper.sweep()).toBe(0);
    expect(resumes).toEqual([]);
    expect((await sessions.getVisibleSession("acme", "alice", "fresh"))?.status).toBe("running");
  });

  it("an awaiting_approval park is not an orphan — the durable approval resume path owns it", async () => {
    const { sessions, sweeper, resumes } = harness();
    await sessions.createSession(run({ id: "parked", status: "awaiting_approval" }));
    expect(await sweeper.sweep()).toBe(0);
    expect(resumes).toEqual([]);
    expect((await sessions.getVisibleSession("acme", "alice", "parked"))?.status).toBe("awaiting_approval");
  });

  it("an unresumable orphan settles as failed with a terminal fact instead of lying 'running' forever", async () => {
    // Given an orphan whose agent spec has vanished since the crash
    const { sessions, sweeper, reports } = harness({
      resume: async () => ({ resumed: false, reason: "agent spec unavailable" }),
    });
    await sessions.createSession(run({}));

    // When the sweep runs
    expect(await sweeper.sweep()).toBe(1);

    // Then the run is SETTLED (fail-closed), visibly, with the run correlation intact
    expect((await sessions.getVisibleSession("acme", "alice", "sess-1"))?.status).toBe("failed");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "agent.run.failed", sessionId: "sess-1", agentId: "sentinel" });
    expect(reports[0]?.runId).toBe("run-1");
  });

  it("with no resume wired (no registry/key store), orphans are still settled — never left running", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await sessions.createSession(run({}));
    const sweeper = buildOrphanSweeper({ sessions, bootAt: BOOT, now: () => "2026-08-07T12:00:01.000Z" });
    expect(await sweeper.sweep()).toBe(1);
    expect((await sessions.getVisibleSession("acme", "alice", "sess-1"))?.status).toBe("failed");
  });
});
