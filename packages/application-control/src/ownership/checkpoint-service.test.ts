import type { HandoffCheckpoint, HandoffCheckpointRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { HandoffCheckpointStore } from "../ports/handoff-checkpoint-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import { type CheckpointRefResolvers, CheckpointService } from "./checkpoint-service.js";

// A handoff is only worth resuming from if its evidence is real and its verdict is somebody else's — the two
// admission rules the service exists to hold (docs/architecture/ownership-protocol.md).

class FakeCheckpointStore implements HandoffCheckpointStore {
  readonly records: HandoffCheckpointRecord[] = [];
  readonly events: OutboxEvent[] = [];

  async create(record: HandoffCheckpointRecord, events?: OutboxEvent[]): Promise<void> {
    this.records.push(record);
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
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({ tenant: "acme", id: record.id });
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
    // When the checkpoint cites a commit / Then it is admitted rather than refused on a check nobody made —
    // and the record SAYS the check was never made: "evidence-backed" and "evidence-verified" are different
    // claims, and a successor reads which one each ref holds.
    const record = await service.create({
      tenant: "acme",
      createdBy: "member-1",
      checkpoint: body({
        confirmedFacts: [{ statement: "the fix is drafted", refs: [{ type: "commit", id: "abc123" }] }],
      }),
    });
    expect(record.confirmedFacts[0]?.refs[0]?.resolution).toBe("unverified_external");
  });

  it("stamps resolver-backed refs as VERIFIED — the existence check that admitted them is on the record", async () => {
    const store = new FakeCheckpointStore();
    const service = new CheckpointService({ store, resolvers: liveRuns("run-42") });
    const record = await service.create({
      tenant: "acme",
      createdBy: "member-1",
      checkpoint: body({
        confirmedFacts: [{ statement: "the suite ran", refs: [{ type: "run", id: "run-42" }] }],
        actionsTaken: [{ description: "ran it", refs: [{ type: "run", id: "run-42" }] }],
      }),
    });
    expect(record.confirmedFacts[0]?.refs[0]?.resolution).toBe("verified");
    expect(record.actionsTaken[0]?.refs[0]?.resolution).toBe("verified");
    expect(store.records[0]?.confirmedFacts[0]?.refs[0]?.resolution).toBe("verified"); // persisted, not just served
  });

  it("overwrites a producer-supplied resolution — only the checker claims what the checker checked", async () => {
    const store = new FakeCheckpointStore();
    const service = new CheckpointService({ store, resolvers: liveRuns("run-42") });
    const record = await service.create({
      tenant: "acme",
      createdBy: "member-1",
      checkpoint: body({
        // A forged "verified" on an unresolvable type must not survive admission.
        confirmedFacts: [{ statement: "trust me", refs: [{ type: "commit", id: "abc123", resolution: "verified" }] }],
      }),
    });
    expect(record.confirmedFacts[0]?.refs[0]?.resolution).toBe("unverified_external");
  });
});

describe("handoff checkpoints — a verifier does not check its own work (O3)", () => {
  const service = (executor: { id: string; sessionId?: string; runId?: string } | undefined) =>
    new CheckpointService({
      store: new FakeCheckpointStore(),
      resolvers: liveRuns("run-42"),
      runActor: async () => executor,
    });

  it("refuses a verifier checkpoint about a run the same actor executed", async () => {
    await expect(
      service({ id: "agent:fixer", runId: "run-42" }).create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ role: "verifier", by: { id: "agent:fixer" } }),
      }),
    ).rejects.toThrow(/cannot verify its own work/);
  });

  it("refuses a verifier checkpoint filed from inside the EXECUTING SESSION — a different actor id is not independence", async () => {
    // Regression (review §11): the service compared actor ids only — its own weaker re-implementation of the
    // domain invariant — so a second agent id verifying from within the same conversation sailed through.
    // The domain's assertIndependentVerification (actor AND run AND session) is now the one decision.
    await expect(
      service({ id: "agent:fixer", runId: "run-42", sessionId: "conv-1" }).create({
        tenant: "acme",
        createdBy: "agent:checker:conv-1",
        checkpoint: body({ role: "verifier", by: { id: "agent:checker", sessionId: "conv-1" } }),
      }),
    ).rejects.toThrow(/inherits its reasoning/);
  });

  it("refuses a verifier checkpoint whose verification ran AS the executing run", async () => {
    await expect(
      service({ id: "agent:fixer", runId: "run-42" }).create({
        tenant: "acme",
        createdBy: "agent:checker:conv-2",
        checkpoint: body({ role: "verifier", by: { id: "agent:checker", runId: "run-42" } }),
      }),
    ).rejects.toThrow(/not independent/);
  });

  it("admits the same checkpoint from an actor that did not execute the run", async () => {
    await expect(
      service({ id: "agent:fixer", runId: "run-42", sessionId: "conv-1" }).create({
        tenant: "acme",
        createdBy: "agent:checker:conv-2",
        checkpoint: body({ role: "verifier", by: { id: "agent:checker", sessionId: "conv-2", runId: "run-99" } }),
      }),
    ).resolves.toBeDefined();
  });

  it("abstains when the checkpoint claims no verdict — an executor's handoff is a claim, not a check", async () => {
    await expect(
      service({ id: "agent:fixer", runId: "run-42" }).create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ role: "executor", by: { id: "agent:fixer" } }),
      }),
    ).resolves.toBeDefined();
  });

  it("abstains when the run's actor cannot be resolved — an invariant we can name beats one we made up", async () => {
    await expect(
      service(undefined).create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ role: "verifier", by: { id: "agent:fixer" } }),
      }),
    ).resolves.toBeDefined();
  });

  it("a rollback-demanding envelope refuses a planless handoff at the minting boundary", async () => {
    // The cross-invariant existed (assertCheckpointForEnvelope) with zero production callers — envelopes are
    // not persisted, so admission never saw one. The producer now carries the policy slice in, and carrying
    // it can only make admission stricter.
    const svc = new CheckpointService({ store: new FakeCheckpointStore(), resolvers: liveRuns("run-42") });
    await expect(
      svc.create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({}),
        envelope: { id: "env-1", rollbackRequired: true },
      }),
    ).rejects.toThrow(/requires rollback/);
    await expect(
      svc.create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ rollbackPlan: "git revert the applied patch series" }),
        envelope: { id: "env-1", rollbackRequired: true },
      }),
    ).resolves.toBeDefined();
  });

  it("refuses an ANONYMOUS verifier checkpoint — omitting `by` is not a way around the independence check", async () => {
    // Regression: `by` is caller-declared (optional on the record, exposed through publish_checkpoint), and a
    // verifier that omitted it made the whole independence check abstain — fail-open on the one field the
    // caller controls. A verification claim without an identity cannot claim independence.
    await expect(
      service({ id: "agent:fixer", runId: "run-42" }).create({
        tenant: "acme",
        createdBy: "agent:fixer:conv-1",
        checkpoint: body({ role: "verifier" }),
      }),
    ).rejects.toThrow(/must declare who verified/);
  });
});
