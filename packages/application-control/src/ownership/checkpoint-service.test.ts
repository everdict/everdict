import type { HandoffCheckpoint } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { HandoffCheckpointStore } from "../ports/handoff-checkpoint-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import { type CheckpointRefResolvers, CheckpointService } from "./checkpoint-service.js";

// A handoff is only worth resuming from if its evidence is real and its verdict is somebody else's — the two
// admission rules the service exists to hold (docs/architecture/ownership-protocol.md).

class FakeCheckpointStore implements HandoffCheckpointStore {
  readonly records: Array<{ tenant: string; id: string }> = [];
  readonly events: OutboxEvent[] = [];

  async create(record: { tenant: string; id: string }, events?: OutboxEvent[]): Promise<void> {
    this.records.push({ tenant: record.tenant, id: record.id });
    if (events) this.events.push(...events);
  }
  async get(): Promise<undefined> {
    return undefined;
  }
  async list(): Promise<never[]> {
    return [];
  }
}

const body = (over: Partial<HandoffCheckpoint> = {}): Omit<HandoffCheckpoint, "id" | "createdAt" | "createdBy"> => ({
  goal: "fix the failing grader",
  currentState: "root cause isolated; fix drafted, tests not yet run",
  confirmedFacts: [{ statement: "the grader throws on empty traces", refs: [{ type: "run", id: "run-42" }] }],
  hypotheses: [],
  actionsTaken: [],
  openDecisions: [],
  remainingTasks: ["run the regression suite"],
  requiredCapabilities: ["run_tests"],
  risks: [],
  validationPlan: "run scorecard sc-7 and compare against sc-6",
  ...over,
});

const liveRuns = (...ids: string[]): CheckpointRefResolvers => ({
  run: async (_tenant, id) => ids.includes(id),
});

describe("handoff checkpoints — evidence admission", () => {
  it("publishes a checkpoint whose evidence resolves, and records the fact in the same write", async () => {
    // Given a workspace where run-42 exists …
    const store = new FakeCheckpointStore();
    const service = new CheckpointService({ store, resolvers: liveRuns("run-42") });
    // When a checkpoint citing it is published …
    const record = await service.create({ tenant: "acme", createdBy: "agent:fixer:conv-1", checkpoint: body() });
    // Then it persists, and the fact rides the same store call (the E0 outbox).
    expect(store.records).toEqual([{ tenant: "acme", id: record.id }]);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.kind).toBe("checkpoint.created");
    // Loop guard #1: an agent-authored handoff stamps its own cause, so it never wakes on its own halt.
    expect(store.events[0]?.causedBy).toBe("agent:fixer:conv-1");
  });

  it("refuses a checkpoint whose 'fact' cites evidence that does not exist", async () => {
    const store = new FakeCheckpointStore();
    const service = new CheckpointService({ store, resolvers: liveRuns("run-42") });
    await expect(
      service.create({
        tenant: "acme",
        createdBy: "member-1",
        checkpoint: body({
          confirmedFacts: [{ statement: "also seen on the old batch", refs: [{ type: "run", id: "run-GONE" }] }],
        }),
      }),
    ).rejects.toThrow(/evidence that does not exist/);
    expect(store.records).toHaveLength(0); // nothing half-written
  });

  it("accepts a ref type the platform cannot resolve — unverifiable is not the same as dangling", async () => {
    // Given no commit resolver (everdict does not host the tenant's git remote) …
    const store = new FakeCheckpointStore();
    const service = new CheckpointService({ store, resolvers: liveRuns("run-42") });
    // When the checkpoint cites a commit / Then it is admitted rather than refused on a check nobody made.
    await expect(
      service.create({
        tenant: "acme",
        createdBy: "member-1",
        checkpoint: body({
          confirmedFacts: [{ statement: "the fix is drafted", refs: [{ type: "commit", id: "abc123" }] }],
        }),
      }),
    ).resolves.toBeDefined();
  });
});

describe("handoff checkpoints — a verifier does not check its own work (O3)", () => {
  const service = (creator: string | undefined) =>
    new CheckpointService({
      store: new FakeCheckpointStore(),
      resolvers: liveRuns("run-42"),
      runCreator: async () => creator,
    });

  it("refuses a verifier checkpoint about a run the same actor executed", async () => {
    await expect(
      service("agent:fixer").create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ role: "verifier", by: { id: "agent:fixer" } }),
      }),
    ).rejects.toThrow(/cannot file a verifier checkpoint/);
  });

  it("admits the same checkpoint from an actor that did not execute the run", async () => {
    await expect(
      service("agent:fixer").create({
        tenant: "acme",
        createdBy: "agent:checker:conv-2",
        checkpoint: body({ role: "verifier", by: { id: "agent:checker" } }),
      }),
    ).resolves.toBeDefined();
  });

  it("abstains when the checkpoint claims no verdict — an executor's handoff is a claim, not a check", async () => {
    await expect(
      service("agent:fixer").create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ role: "executor", by: { id: "agent:fixer" } }),
      }),
    ).resolves.toBeDefined();
  });

  it("abstains when the run's creator cannot be resolved — an invariant we can name beats one we made up", async () => {
    await expect(
      service(undefined).create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ role: "verifier", by: { id: "agent:fixer" } }),
      }),
    ).resolves.toBeDefined();
  });
});
