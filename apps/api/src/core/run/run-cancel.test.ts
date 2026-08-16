import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { ConflictError, NotFoundError, UpstreamError } from "@everdict/contracts";
import type { CaseJob, EvalCase } from "@everdict/contracts";
import { InMemoryPlatformEventStore, InMemoryRunStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";

// ── THE STANDALONE RUN'S USER STOP (RunService.cancel) ───────────────────────────────────────────────
//
// The batch protocol at run scale: the terminal commit is the DECISION (failed{CANCELLED}, first-terminal-wins),
// and only a committed settlement earns the teardown that frees the compute. These pin the three properties the
// protocol stands on — the decision's shape, the teardown's arms, and the convergent retry.

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in cancel tests");
  },
};

const now = "2026-08-16T00:00:00.000Z";

// A run already at a given point of its life — the cancel's subject, planted directly so the test is about
// the cancel rather than about dispatch timing.
function queuedRun(overrides: Partial<ReturnType<typeof Run.newQueued>> = {}) {
  return {
    ...Run.newQueued({
      id: "r1",
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      evalCase: CASE,
      runtime: "nomad-1",
      submittedBy: "alice",
      now,
    }),
    ...overrides,
  };
}

// The teardown arms, recording what they were asked to stop.
function teardownSpies() {
  return {
    killCase: vi.fn(async () => ({ status: "stopped" as const })),
    cancelQueued: vi.fn((_predicate: (job: CaseJob) => boolean) => 1),
    cancelLeased: vi.fn(async (_predicate: (job: CaseJob) => boolean) => 1),
  };
}

describe("RunService.cancel — the standalone run's user stop", () => {
  it("settles a running run failed{CANCELLED}, publishes the terminal fact, and tears its compute down", async () => {
    // Given a run whose compute has begun
    const facts = new InMemoryPlatformEventStore();
    const store = new InMemoryRunStore(facts); // the E0 pair: the fact appends with the write
    await store.create(queuedRun({ status: "running" }));
    const spies = teardownSpies();
    const service = new RunService({ dispatcher: unusedDispatcher, store, ...spies, now: () => now });

    // When the member stops it
    const cancelled = await service.cancel({ tenant: "acme", id: "r1" });

    // Then the decision is the run lifecycle's cancellation shape — a failed run whose reason is CANCELLED
    // (the status union is deliberately not widened)
    expect(cancelled.status).toBe("failed");
    expect(cancelled.error?.code).toBe("CANCELLED");

    // …the terminal fact rode the settle (E0 outbox — a cancelled run is workspace news like any ending)
    const emitted = (await facts.list("acme")).filter((e) => e.kind === "run.failed");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.subject).toEqual({ type: "run", id: "r1" });

    // …and every teardown arm fired against THIS run's job identity
    expect(spies.killCase).toHaveBeenCalledWith("acme", "nomad-1", "c1");
    expect(spies.cancelQueued).toHaveBeenCalledTimes(1);
    expect(spies.cancelLeased).toHaveBeenCalledTimes(1);
    const thisRunsJob = { evalCase: CASE, harness: { id: "s", version: "0" }, runId: "evd-run-r1" } as CaseJob;
    const otherRunsJob = { ...thisRunsJob, runId: "evd-run-r2" };
    for (const spy of [spies.cancelQueued, spies.cancelLeased]) {
      const predicate = spy.mock.calls[0]?.[0];
      expect(predicate?.(thisRunsJob)).toBe(true);
      expect(predicate?.(otherRunsJob)).toBe(false); // …and never another run's work
    }
  });

  it("reclaims a still-queued run from the scheduler — and kills anyway, because the status is a snapshot", async () => {
    const store = new InMemoryRunStore();
    await store.create(queuedRun());
    const spies = teardownSpies();
    const service = new RunService({ dispatcher: unusedDispatcher, store, ...spies, now: () => now });

    expect((await service.cancel({ tenant: "acme", id: "r1" })).error?.code).toBe("CANCELLED");
    expect(spies.cancelQueued).toHaveBeenCalledTimes(1); // dropped from the scheduler queue
    // A run read as queued may have been dispatched a millisecond later; the kill of a case with no job is a
    // no-op at the backend, and skipping it on the strength of a stale read is not.
    expect(spies.killCase).toHaveBeenCalledTimes(1);
  });

  it("aborts the dispatch this replica is awaiting, and the losing driver never overwrites the cancel", async () => {
    // Given a dispatch that hangs until its signal aborts — the shape of a real in-flight run
    const store = new InMemoryRunStore();
    const hanging: Dispatcher = {
      dispatch: (_job, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted by cancel")));
        }),
    };
    const service = new RunService({ dispatcher: hanging, store, newId: () => "r1" });
    const submitted = await service.submit({ tenant: "acme", harness: { id: "scripted", version: "0" }, case: CASE });
    await new Promise((r) => setTimeout(r, 0)); // let track() register the controller

    // When the run is cancelled
    await service.cancel({ tenant: "acme", id: submitted.id });
    await new Promise((r) => setTimeout(r, 0)); // …and the aborted driver runs its own catch

    // Then the driver's failure settle was refused by the terminal CAS — the cancel's reason survives
    const after = await service.get(submitted.id);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("CANCELLED");
  });

  it("converges on retry: re-cancelling an already-cancelled run re-runs the teardown instead of conflicting", async () => {
    // Given a cancel whose teardown left work behind (the crash/5xx case), the DECISION is already durable
    const store = new InMemoryRunStore();
    await store.create(queuedRun({ status: "running" }));
    const spies = teardownSpies();
    const service = new RunService({ dispatcher: unusedDispatcher, store, ...spies, now: () => now });
    await service.cancel({ tenant: "acme", id: "r1" });

    // When the caller retries
    const again = await service.cancel({ tenant: "acme", id: "r1" });

    // Then it succeeds and the teardown ran a second time — what a retry owes is the teardown, not the decision
    expect(again.error?.code).toBe("CANCELLED");
    expect(spies.killCase).toHaveBeenCalledTimes(2);
    expect(spies.cancelLeased).toHaveBeenCalledTimes(2);
  });

  it("reports a kill that failed instead of certifying a teardown that did not happen", async () => {
    const store = new InMemoryRunStore();
    await store.create(queuedRun({ status: "running" }));
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      // The seam ANSWERS now (arch-review 52, Wave 3) — this is the shape a cluster that could not be
      // reached reports, and it must be read as "not converged" exactly as a rejection was.
      killCase: async () => ({ status: "failed" as const, reason: "nomad unreachable" }),
      now: () => now,
    });

    await expect(service.cancel({ tenant: "acme", id: "r1" })).rejects.toBeInstanceOf(UpstreamError);
    // …over a record that IS cancelled: the decision committed, only its teardown is owed.
    expect((await store.get("r1"))?.error?.code).toBe("CANCELLED");
  });

  it("conflicts on a run that already finished — cancelling finished work cancels nothing", async () => {
    const store = new InMemoryRunStore();
    await store.create(queuedRun({ status: "succeeded" }));
    const service = new RunService({ dispatcher: unusedDispatcher, store, now: () => now });
    await expect(service.cancel({ tenant: "acme", id: "r1" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("conflicts on a scorecard child — its parent's teardown owns it", async () => {
    const store = new InMemoryRunStore();
    await store.create(queuedRun({ status: "running", parentScorecardId: "sc-1" }));
    const service = new RunService({ dispatcher: unusedDispatcher, store, now: () => now });
    await expect(service.cancel({ tenant: "acme", id: "r1" })).rejects.toBeInstanceOf(ConflictError);
    expect((await store.get("r1"))?.status).toBe("running"); // untouched
  });

  it("answers NOT_FOUND for another workspace's run and for a missing one (no existence leak)", async () => {
    const store = new InMemoryRunStore();
    await store.create(queuedRun({ status: "running" }));
    const service = new RunService({ dispatcher: unusedDispatcher, store, now: () => now });
    await expect(service.cancel({ tenant: "other", id: "r1" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.cancel({ tenant: "acme", id: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await store.get("r1"))?.status).toBe("running");
  });

  it("answers NOT_FOUND when another member stops a personal execution (the audience rule, not a 403)", async () => {
    const store = new InMemoryRunStore();
    await store.create(
      Run.newChatTurn({ id: "turn-alice", tenant: "acme", agentId: "default", sessionId: "s1", actor: "alice", now }),
    );
    const service = new RunService({ dispatcher: unusedDispatcher, store, now: () => now });
    await expect(service.cancel({ tenant: "acme", id: "turn-alice", viewer: "bob" })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // The owner stops their own turn — and it settles through the AGENT verb, so the run.* family stays
    // silent (agent.run.* still carries that lifecycle) while the row lands on the same failed{CANCELLED}.
    const cascaded: string[] = [];
    const owned = new RunService({
      dispatcher: unusedDispatcher,
      store,
      now: () => now,
      onAgentRunCancelled: async (_tenant, runId) => {
        cascaded.push(runId);
        return { cancelled: 1, failures: [] };
      },
    });
    const stopped = await owned.cancel({ tenant: "acme", id: "turn-alice", viewer: "alice" });
    expect(stopped.status).toBe("failed");
    expect(stopped.error?.code).toBe("CANCELLED");
    // AWAITED inside the teardown now (arch-review 52, Wave 3) — the cascade used to be fired into the void
    // beside the commit, so a crash in between orphaned the whole subtree with nothing recording it owed.
    expect(cascaded).toEqual(["turn-alice"]); // stopping an agent run revokes the tree it caused
  });
});
