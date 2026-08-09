import type {
  ActorRef,
  HandoffCheckpoint,
  HandoffCheckpointRecord,
  TaskEnvelope,
  VerificationDecision,
} from "@everdict/contracts";
import { HandoffCheckpointSchema } from "@everdict/contracts";
import { authorizeResourceAccess } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { HandoffCheckpointStore } from "../ports/handoff-checkpoint-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import type { VerificationDecisionStore } from "../ports/verification-decision-store.js";
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

// arch-review 10 P1 — the spawn path. Three things this used to claim and do none of: it never compared the
// verifier to the executor, it never persisted the verdict, and the "evidence only" envelope put resource
// ids in the CAPABILITY list where they matched no tool. All three are checked here, at the seam.
describe("verification — a spawned verdict is checked for independence and FILED", () => {
  class FakeVerifications implements VerificationDecisionStore {
    readonly records: VerificationDecision[] = [];
    readonly events: OutboxEvent[] = [];
    async create(record: VerificationDecision, events?: OutboxEvent[]): Promise<void> {
      this.records.push(record);
      if (events) this.events.push(...events);
    }
    async get(): Promise<undefined> {
      return undefined;
    }
    async listForSubject(): Promise<VerificationDecision[]> {
      return [...this.records];
    }
    async list(): Promise<VerificationDecision[]> {
      return [...this.records];
    }
  }

  const checkpoint: HandoffCheckpointRecord = {
    ...HandoffCheckpointSchema.parse({
      ...body(),
      id: "cp-1",
      createdAt: "2026-08-08T00:00:00.000Z",
      createdBy: "agent:fixer:conv-1",
    }),
    tenant: "acme",
  };

  function build(opts: {
    verdictActor: ActorRef;
    executor?: ActorRef;
    verifications?: VerificationDecisionStore;
  }): { svc: CheckpointService; envelopes: TaskEnvelope[] } {
    const envelopes: TaskEnvelope[] = [];
    const store: HandoffCheckpointStore = {
      async create() {},
      async get() {
        return checkpoint;
      },
      async list() {
        return [];
      },
    };
    const svc = new CheckpointService({
      store,
      resolvers: {},
      ...(opts.executor ? { runActor: async () => opts.executor } : {}),
      ...(opts.verifications ? { verifications: opts.verifications } : {}),
      verifier: {
        async verify(input) {
          envelopes.push(input.envelope);
          return { verdict: "verified", detail: "the run's trace supports the claim", actor: opts.verdictActor };
        },
      },
      newId: () => "vd-1",
      now: () => "2026-08-08T01:00:00.000Z",
    });
    return { svc, envelopes };
  }

  it("hands the verifier read TOOLS and pins its RESOURCES to the evidence", async () => {
    const { svc, envelopes } = build({ verdictActor: { id: "agent:auditor", runId: "run-99" } });
    await svc.requestVerification("acme", "cp-1");
    const envelope = envelopes[0];
    expect(envelope?.scope.writes).toEqual([]);
    // Capability half: real tool names, so the verifier can actually call something. The old shape wrote
    // "run:run-42" here, which matched no tool — the envelope blocked every call it was meant to permit.
    expect(envelope?.scope.reads).toContain("get_run");
    // Resource half: exactly the evidence, and the guard that enforces it.
    expect(envelope?.scope.resources).toEqual([{ type: "run", id: "run-42" }]);
    expect(authorizeResourceAccess({ type: "run", id: "run-42" }, envelope as TaskEnvelope)).toEqual({
      allowed: true,
    });
    expect(authorizeResourceAccess({ type: "run", id: "run-43" }, envelope as TaskEnvelope)).toMatchObject({
      allowed: false,
    });
  });

  it("REFUSES a verdict from the actor that did the work — the check that previously did not exist", async () => {
    const executor: ActorRef = { id: "agent:fixer", runId: "run-42", sessionId: "conv-1" };
    const { svc } = build({ verdictActor: executor, executor });
    await expect(svc.requestVerification("acme", "cp-1")).rejects.toThrow(/cannot verify its own work/);
  });

  it("REFUSES a verdict produced inside the executing session, even from a different agent id", async () => {
    // The failure a bare-string `actor` could never catch: same session, different id. Everdict's invariant
    // is actor AND run AND session, and only an ActorRef can be asked the last two.
    const { svc } = build({
      verdictActor: { id: "agent:auditor", sessionId: "conv-1" },
      executor: { id: "agent:fixer", runId: "run-42", sessionId: "conv-1" },
    });
    await expect(svc.requestVerification("acme", "cp-1")).rejects.toThrow(/executing session/);
  });

  it("FILES the verdict as a durable decision naming both actors and how independence was decided", async () => {
    const verifications = new FakeVerifications();
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99", sessionId: "conv-2" },
      executor: { id: "agent:fixer", runId: "run-42", sessionId: "conv-1" },
      verifications,
    });
    const decision = await svc.requestVerification("acme", "cp-1", { requestedBy: "member:dana" });
    expect(decision).toMatchObject({
      subject: { type: "checkpoint", id: "cp-1" },
      verdict: "verified",
      independence: "enforced",
      verifier: { id: "agent:auditor" },
      executor: { id: "agent:fixer" },
    });
    expect(verifications.records).toHaveLength(1);
    // …and the workspace hears it, with the independence result in the payload — a verdict that could not be
    // checked must never read like one that was.
    expect(verifications.events[0]?.kind).toBe("checkpoint.verified");
  });

  it("says ABSTAINED when the executor cannot be resolved — never silently 'independent'", async () => {
    const verifications = new FakeVerifications();
    const { svc } = build({ verdictActor: { id: "agent:auditor" }, verifications });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.independence).toBe("abstained");
    expect(decision.executor).toBeUndefined();
  });
});
