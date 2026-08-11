import type {
  ActorRef,
  CheckpointRef,
  HandoffCheckpoint,
  HandoffCheckpointRecord,
  TaskEnvelope,
  VerificationDecision,
} from "@everdict/contracts";
import { HandoffCheckpointSchema } from "@everdict/contracts";
import { type EvidenceIdentity, VERIFIER_POLICY_VERSION, authorizeResourceAccess } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { HandoffCheckpointStore } from "../ports/handoff-checkpoint-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import type { VerificationDecisionStore } from "../ports/verification-decision-store.js";
import { type CheckpointRefResolvers, CheckpointService, type CheckpointServiceDeps } from "./checkpoint-service.js";

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

// The tool the platform designates as each evidence kind's reader. A double that reported some OTHER tool
// would be reporting a read of the executor's story, which no longer counts as coverage.
const READER_BY_TYPE: Record<string, string> = {
  run: "get_run",
  scorecard: "get_scorecard",
  file: "get_file",
  issue: "get_issue",
};

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
    reviewed?: Array<{ type: string; id: string }>;
    claimDigest?: string; // what the runner says it RENDERED — differing from what was sent is its own test
    policyDigest?: string; // …and the same for the decision procedure
    // WHICH instrument the runner says produced the verdict — absent or `extended` is its own test.
    // `null` = the runner reported none, which is its own refusal.
    executionProfile?: {
      modelRef: string;
      version: string;
      documentDigest: string;
      closure: "primary_only" | "extended";
    } | null;
    unwired?: true; // this deployment has no pin resolver at all
    readerOverride?: string; // which tool the runtime reports doing the reading
    evidencePins?: CheckpointServiceDeps["evidencePins"]; // which VERSION the plan resolved
    // …and which one the READ observed. Absent = the double saw exactly what it was pinned to.
    observedEvidence?: Array<{ type: string; id: string; identity?: EvidenceIdentity; moved?: true }>;
    evidence?: CheckpointRef[]; // what the checkpoint cites (defaults to the run above)
  }): { svc: CheckpointService; envelopes: TaskEnvelope[]; claims: unknown[] } {
    const envelopes: TaskEnvelope[] = [];
    const cited =
      opts.evidence === undefined
        ? checkpoint
        : ({
            ...checkpoint,
            confirmedFacts: [{ statement: "the grader throws on empty traces", refs: opts.evidence }],
          } as HandoffCheckpointRecord);
    const store: HandoffCheckpointStore = {
      async create() {},
      async get() {
        return cited;
      },
      async list() {
        return [];
      },
    };
    const claims: unknown[] = [];
    const svc = new CheckpointService({
      store,
      resolvers: {},
      // A wired deployment: every pinnable ref gets an identity. `evidencePins` is optional on the SERVICE,
      // and the scenario for a deployment that never wired it is separate — the point being that the absence
      // is a refusal, not a quiet affirmative.
      ...(opts.unwired === true
        ? {}
        : {
            evidencePins:
              opts.evidencePins ??
              (async (_t: string, refs: ReadonlyArray<{ type: string; id: string }>) =>
                refs.map((r) => ({
                  type: r.type,
                  id: r.id,
                  identity:
                    r.type === "run"
                      ? ({ kind: "run", updatedAt: "2026-08-08T00:00:00.000Z", status: "succeeded" } as const)
                      : ({ kind: "scorecard", scoringRevision: 1, scorePlaneDigest: "sha256:p1" } as const),
                }))),
          }),
      ...(opts.executor ? { runActor: async () => opts.executor } : {}),
      ...(opts.verifications ? { verifications: opts.verifications } : {}),
      verifier: {
        async verify(input) {
          envelopes.push(input.envelope);
          claims.push(input.claim);
          return {
            verdict: "verified",
            detail: "the run's trace supports the claim",
            actor: opts.verdictActor,
            // What the RUNTIME observed being read — WITH the tool that read it, because coverage is
            // per-reader: the evidence reader and the trajectory reader address the same run and only one of
            // them is evidence about the artifact.
            reviewedResources: (opts.reviewed ?? [{ type: "run", id: "run-42" }]).map((r) => ({
              ...r,
              tool: opts.readerOverride ?? READER_BY_TYPE[r.type] ?? "get_run",
            })),
            // The echoes: the claim and the POLICY the runner actually rendered. Equal to what was sent =
            // affirmable. The policy echo is what stops a verdict reached under some other constitution.
            claimDigest: opts.claimDigest ?? input.claim.digest,
            policyDigest: opts.policyDigest ?? input.policy.digest,
            // WHAT THE READER SAW. The decision records this, never the caller's preflight resolution — the
            // default double observes exactly what it was pinned to, and the scenarios below vary it.
            observedEvidence:
              opts.observedEvidence ?? (input.evidencePins ?? []).map((p) => ({ ...p, identity: p.identity })),
            // WHICH INSTRUMENT answered — and that nothing else could have. A verdict whose executor nobody
            // can name is not reproducible, so the service refuses to make it affirmative.
            ...(opts.executionProfile === null
              ? {}
              : {
                  executionProfile: opts.executionProfile ?? {
                    modelRef: "trusted-verifier",
                    version: "1.0.0",
                    documentDigest: "sha256:verifier",
                    closure: "primary_only" as const,
                  },
                }),
          };
        },
      },
      newId: () => "vd-1",
      now: () => "2026-08-08T01:00:00.000Z",
    });
    return { svc, envelopes, claims };
  }

  // arch-review 24 P0-3. The question said "does this evidence support the checkpoint's confirmed facts?"
  // while the confirmed facts stayed on this side of the process boundary. The verifier could only judge
  // whether the artifacts were internally coherent — a different question — and the platform filed the answer
  // as support for claims the verifier never saw.
  it("carries the CLAIM itself across the boundary, and records which claim the verdict was about", async () => {
    const { svc, claims } = build({ verdictActor: { id: "agent:auditor", runId: "run-99" } });
    const decision = await svc.requestVerification("acme", "cp-1");
    const claim = claims[0] as { subject: { id: string }; statements: Array<{ statement: string }>; digest: string };
    expect(claim.subject.id).toBe("cp-1");
    expect(claim.statements.map((x) => x.statement)).toEqual(["the grader throws on empty traces"]);
    // …and the decision records it, so a reader a year later can tell WHICH assertion run-42 was held to.
    expect(decision.claim).toMatchObject({
      digest: claim.digest,
      echoed: claim.digest,
      statements: ["the grader throws on empty traces"],
    });
  });

  // arch-review 25 P0-3: EXISTENCE IS NOT EVIDENCE IDENTITY. `scorecard:sc-7` is a locator — a re-score
  // rewrites that batch's judgments in place, so a decision citing only the id says "the verifier looked at
  // sc-7" while anyone opening it a month later sees a different set of verdicts than the verifier saw.
  it("records WHICH VERSION of the evidence the verdict is about", async () => {
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99" },
      evidence: [{ type: "scorecard", id: "sc-7" }],
      evidencePins: async () => [
        {
          type: "scorecard",
          id: "sc-7",
          identity: { kind: "scorecard", scoringRevision: 3, scorePlaneDigest: "sha256:p3" },
        },
      ],
    });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.evidenceIdentity).toEqual([
      {
        type: "scorecard",
        id: "sc-7",
        identity: { kind: "scorecard", scoringRevision: 3, scorePlaneDigest: "sha256:p3" },
      },
    ]);
  });

  // arch-review 26 P0: PRE-READ IDENTITY IS NOT OBSERVATION IDENTITY. The plan resolves an identity before
  // the verifier runs; what the verifier is handed is a locator, and the reader returns whatever it resolves
  // to at the moment of the call. A re-score landing in between produced a decision naming revision 3 while
  // the model had read revision 4 — every artifact around it consistent, and the sentence it recorded false.
  it("records the identity the READ observed, not the one the plan resolved", async () => {
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99" },
      evidence: [{ type: "scorecard", id: "sc-7" }],
      reviewed: [{ type: "scorecard", id: "sc-7" }],
      evidencePins: async () => [
        {
          type: "scorecard",
          id: "sc-7",
          identity: { kind: "scorecard", scoringRevision: 3, scorePlaneDigest: "sha256:p3" },
        },
      ],
      // The reader is pinned to revision 3 and would refuse anything else; this double reports what it saw.
      observedEvidence: [
        {
          type: "scorecard",
          id: "sc-7",
          identity: { kind: "scorecard", scoringRevision: 3, scorePlaneDigest: "sha256:p3" },
        },
      ],
    });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.evidenceIdentity).toEqual([
      {
        type: "scorecard",
        id: "sc-7",
        identity: { kind: "scorecard", scoringRevision: 3, scorePlaneDigest: "sha256:p3" },
      },
    ]);
    // …and no evidence-version gap was raised: the read agreed with the plan. (The verdict is still
    // inconclusive here for an unrelated reason — a scorecard-only checkpoint resolves no executor, so
    // independence abstains. Asserting the identity is what this scenario is about.)
    expect(decision.detail).not.toContain("the version of");
  });

  // arch-review 27 P1: A RESOLVER WIRED TODAY IS NOT AN INVARIANT OWNED. `evidencePins` is optional on the
  // service, so a deployment that simply never wired it produced decisions with no identities at all — and
  // nothing in the gaps said so, which meant full coverage plus independence was enough to mint `verified`
  // over evidence whose version nobody recorded.
  it("refuses the affirmative when this deployment cannot pin the evidence at all", async () => {
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99" },
      evidencePins: undefined,
      unwired: true,
    });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("cannot pin the version of");
  });

  // …and the same for the instrument: a verdict whose executor nobody can name is not reproducible either.
  it("refuses the affirmative when the runner names no instrument", async () => {
    const { svc } = build({ verdictActor: { id: "agent:auditor", runId: "run-99" }, executionProfile: null });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("which model produced this verdict");
  });

  it("refuses the affirmative when the verifier ran with an EXTENDED model ladder", async () => {
    // A fallback, a summarizer tier or a sub-agent model means the verdict's authority is not the single
    // platform document the record names — which is the whole reason the ladder is cut for a verification.
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99" },
      executionProfile: {
        modelRef: "trusted-verifier",
        version: "1.0.0",
        documentDigest: "sha256:verifier",
        closure: "extended",
      },
    });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("extended model ladder");
  });

  it("refuses the affirmative when the artifact MOVED between the plan and the read", async () => {
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99" },
      evidence: [{ type: "scorecard", id: "sc-7" }],
      evidencePins: async () => [
        {
          type: "scorecard",
          id: "sc-7",
          identity: { kind: "scorecard", scoringRevision: 3, scorePlaneDigest: "sha256:p3" },
        },
      ],
      // The reader refused it: a re-score landed, so what the locator resolves to is no longer the artifact
      // this verification was planned against.
      observedEvidence: [{ type: "scorecard", id: "sc-7", moved: true }],
    });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("the version of scorecard:sc-7 that the verifier actually read");
    expect(decision.evidenceIdentity).toEqual([{ type: "scorecard", id: "sc-7", unpinnable: true }]);
  });

  it("refuses the affirmative when the evidence's version could not be pinned", async () => {
    // A resolver that ran and could not answer is the third state. The verdict is still filed — it happened —
    // but nobody can put the same artifact in front of a second verifier, which is what "verified" claims.
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99" },
      evidence: [{ type: "scorecard", id: "sc-7" }],
      evidencePins: async () => [], // wired, ran, answered for nothing
    });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("could not be established");
    expect(decision.evidenceIdentity).toEqual([{ type: "scorecard", id: "sc-7", unpinnable: true }]);
  });

  // arch-review 25 P0-4: the procedure has an identity too, and a verdict reached under another one is a
  // verdict about a different question.
  it("refuses the affirmative when the runner applied a DIFFERENT policy than the platform's", async () => {
    const { svc } = build({ verdictActor: { id: "agent:auditor", runId: "run-99" }, policyDigest: "sha256:theirs" });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("a different policy");
    expect(decision.policy).toMatchObject({ applied: "sha256:theirs" });
  });

  it("records the platform's policy VERSION and digest on every decision", async () => {
    const { svc } = build({ verdictActor: { id: "agent:auditor", runId: "run-99" } });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.policy?.version).toBe(VERIFIER_POLICY_VERSION);
    expect(decision.policy?.applied).toBe(decision.policy?.digest);
  });

  it("refuses the affirmative when the runner rendered a DIFFERENT claim than the one under review", async () => {
    // A verdict about some other text is not a verdict about this checkpoint, however confident it sounds.
    const { svc } = build({ verdictActor: { id: "agent:auditor", runId: "run-99" }, claimDigest: "sha256:other" });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("a different claim");
    expect(decision.claim).toMatchObject({ echoed: "sha256:other" });
  });

  // arch-review 24 P0-4. Two tools address one run: the evidence reader returns the run's recorded outcome,
  // the trajectory reader returns the executor's own account of producing it. Counting the second as coverage
  // certifies "the verifier examined run-42" for a verifier that read the story about run-42 — which is the
  // exact context separation this envelope exists to enforce, defeated through the coverage door.
  it("does NOT count a trajectory read as having examined the evidence", async () => {
    const { svc } = build({
      verdictActor: { id: "agent:auditor", runId: "run-99" },
      reviewed: [{ type: "run", id: "run-42" }],
      readerOverride: "get_run_trajectory",
    });
    const decision = await svc.requestVerification("acme", "cp-1");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("never successfully read");
    expect(decision.evidenceCoverage).toMatchObject({ reviewed: [] });
  });

  // …and the production DEFAULT must not grant that tool at all. The invariant held only in tests that passed
  // their own tool list; the default the control plane actually ships with named it.
  it("does not grant the trajectory reader by default", async () => {
    const { svc, envelopes } = build({ verdictActor: { id: "agent:auditor", runId: "run-99" } });
    await svc.requestVerification("acme", "cp-1");
    expect(envelopes[0]?.scope.reads).not.toContain("get_run_trajectory");
  });

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
      executors: [{ id: "agent:fixer", runId: "run-42", sessionId: "conv-1" }],
    });
    expect(decision.evidenceCoverage).toMatchObject({ offered: 1, reviewed: [{ type: "run", id: "run-42" }] });
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
    expect(decision.executors).toEqual([]);
    // …and an unproven independence cannot carry an affirmative verdict.
    expect(decision.verdict).toBe("inconclusive");
  });
});

// arch-review 11: a checkpoint can cite SEVERAL runs, and they can have different executors. Resolving "the
// first run reference that resolves" produced an independence claim with a hole exactly the size of the
// second executor — and the hole opens for the verifier that has the most reason to want it.
describe("verification — independence is checked against EVERY executor in the evidence", () => {
  const twoRuns: HandoffCheckpointRecord = {
    ...HandoffCheckpointSchema.parse({
      ...body({
        confirmedFacts: [
          { statement: "the grader throws on empty traces", refs: [{ type: "run", id: "run-A" }] },
          { statement: "the fix holds under load", refs: [{ type: "run", id: "run-B" }] },
        ],
      }),
      id: "cp-multi",
      createdAt: "2026-08-08T00:00:00.000Z",
      createdBy: "member:dana",
    }),
    tenant: "acme",
  };
  const actors: Record<string, ActorRef> = {
    "run-A": { id: "agent:alpha", runId: "run-A", sessionId: "conv-A" },
    "run-B": { id: "agent:beta", runId: "run-B", sessionId: "conv-B" },
  };

  const svcWith = (verdictActor: ActorRef, store?: VerificationDecisionStore): CheckpointService =>
    new CheckpointService({
      store: {
        async create() {},
        async get() {
          return twoRuns;
        },
        async list() {
          return [];
        },
      },
      resolvers: {},
      runActor: async (_tenant, runId) => actors[runId],
      ...(store ? { verifications: store } : {}),
      verifier: {
        async verify() {
          return { verdict: "verified", detail: "both runs support the claim", actor: verdictActor };
        },
      },
      newId: () => "vd-multi",
      now: () => "2026-08-08T01:00:00.000Z",
    });

  it("REFUSES a verdict from the SECOND executor, whom a first-match resolver never compared against", async () => {
    // agent:beta executed run-B, which is in this very evidence. Resolving run-A first and stopping made
    // beta look independent of alpha — true, and not the question. It is judging its own work.
    await expect(svcWith(actors["run-B"] as ActorRef).requestVerification("acme", "cp-multi")).rejects.toThrow(
      /cannot verify its own work/,
    );
  });

  it("records EVERY executor the verdict covers, so the decision says what it was checked against", async () => {
    class Sink implements VerificationDecisionStore {
      readonly records: VerificationDecision[] = [];
      async create(record: VerificationDecision): Promise<void> {
        this.records.push(record);
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
    const sink = new Sink();
    const decision = await svcWith(
      { id: "agent:auditor", runId: "run-Z", sessionId: "conv-Z" },
      sink,
    ).requestVerification("acme", "cp-multi");
    expect(decision.executors.map((a) => a.id)).toEqual(["agent:alpha", "agent:beta"]);
    expect(decision.independence).toBe("enforced");
    expect(sink.records).toHaveLength(1);
  });
});

// arch-review 12: "verified" is a strong word, and the PLATFORM decides whether a decision earns it. Two
// gaps used to be invisible — independence established against only some of the executors, and a verifier
// that never opened the evidence at all. Both are recorded, and both refuse an affirmative.
describe("verification — an affirmative needs full identity AND evidence coverage", () => {
  const checkpoint: HandoffCheckpointRecord = {
    ...HandoffCheckpointSchema.parse({
      ...body({
        confirmedFacts: [
          { statement: "the fix holds", refs: [{ type: "run", id: "run-A" }] },
          { statement: "and it shipped", refs: [{ type: "run", id: "run-B" }] },
        ],
      }),
      id: "cp-cov",
      createdAt: "2026-08-08T00:00:00.000Z",
      createdBy: "member:dana",
    }),
    tenant: "acme",
  };

  const svc = (opts: {
    resolvable: Record<string, ActorRef>;
    reviewed?: Array<{ type: string; id: string }>;
  }): CheckpointService =>
    new CheckpointService({
      store: {
        async create() {},
        async get() {
          return checkpoint;
        },
        async list() {
          return [];
        },
      },
      resolvers: {},
      runActor: async (_t, runId) => opts.resolvable[runId],
      evidencePins: async (_t, refs) =>
        refs.map((r) => ({
          type: r.type,
          id: r.id,
          identity: { kind: "run", updatedAt: "2026-08-08T00:00:00.000Z", status: "succeeded" } as const,
        })),
      verifier: {
        async verify(input) {
          return {
            verdict: "verified" as const,
            detail: "the evidence supports it",
            actor: { id: "agent:auditor", runId: "run-Z", sessionId: "conv-Z" },
            ...(opts.reviewed
              ? {
                  reviewedResources: opts.reviewed.map((r) => ({ ...r, tool: READER_BY_TYPE[r.type] ?? "get_run" })),
                }
              : {}),
            claimDigest: input.claim.digest,
            policyDigest: input.policy.digest,
            // The readers observed exactly what they were pinned to — the ordinary case.
            observedEvidence: (input.evidencePins ?? []).map((p) => ({ ...p, identity: p.identity })),
            executionProfile: {
              modelRef: "trusted-verifier",
              version: "1.0.0",
              documentDigest: "sha256:verifier",
              closure: "primary_only" as const,
            },
          };
        },
      },
      newId: () => "vd-cov",
      now: () => "2026-08-08T01:00:00.000Z",
    });

  const bothRuns = [
    { type: "run", id: "run-A" },
    { type: "run", id: "run-B" },
  ];

  it("records PARTIAL independence and refuses the affirmative when one executor could not be resolved", () => {
    // The collapse the two-state field made: independent of A, unknown of B, recorded as "enforced".
    return expect(
      svc({
        resolvable: { "run-A": { id: "agent:alpha", runId: "run-A" } },
        reviewed: bothRuns,
      }).requestVerification("acme", "cp-cov"),
    ).resolves.toMatchObject({
      independence: "partial",
      verdict: "inconclusive",
      executorCoverage: { runRefs: 2, unresolvedRunIds: ["run-B"] },
    });
  });

  it("refuses the affirmative when the verifier never opened part of its evidence", async () => {
    // The resource scope proves it could not look OUTSIDE. This is the other half: that it looked INSIDE.
    const decision = await svc({
      resolvable: {
        "run-A": { id: "agent:alpha", runId: "run-A" },
        "run-B": { id: "agent:beta", runId: "run-B" },
      },
      reviewed: [{ type: "run", id: "run-A" }],
    }).requestVerification("acme", "cp-cov");
    expect(decision.independence).toBe("enforced");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("never successfully read");
    expect(decision.evidenceCoverage).toMatchObject({ offered: 2, reviewed: [{ type: "run", id: "run-A" }] });
  });

  it("AFFIRMS when every executor resolved and every offered ref was read", async () => {
    const decision = await svc({
      resolvable: {
        "run-A": { id: "agent:alpha", runId: "run-A" },
        "run-B": { id: "agent:beta", runId: "run-B" },
      },
      reviewed: bothRuns,
    }).requestVerification("acme", "cp-cov");
    expect(decision).toMatchObject({ verdict: "verified", independence: "enforced" });
  });
});

// arch-review 13: coverage means SUCCESSFULLY READ, not addressed. The kernel used to report a resource the
// moment the object gate admitted it — before the tool ran — so a verifier could reach for all three of its
// refs, get a 404 on every one, and still show full coverage. An affirmative built on three failures.
describe("verification — a failed read is not coverage", () => {
  const checkpoint: HandoffCheckpointRecord = {
    ...HandoffCheckpointSchema.parse({
      ...body(),
      id: "cp-fail",
      createdAt: "2026-08-08T00:00:00.000Z",
      createdBy: "member:dana",
    }),
    tenant: "acme",
  };

  it("refuses the affirmative and NAMES the failed read", async () => {
    const svc = new CheckpointService({
      store: {
        async create() {},
        async get() {
          return checkpoint;
        },
        async list() {
          return [];
        },
      },
      resolvers: {},
      runActor: async () => ({ id: "agent:fixer", runId: "run-42", sessionId: "conv-1" }),
      verifier: {
        async verify(input) {
          return {
            verdict: "verified" as const,
            detail: "looks right",
            actor: { id: "agent:auditor", runId: "run-Z", sessionId: "conv-Z" },
            // Addressed, and the read FAILED — the distinction the outcome exists to carry.
            reviewedResources: [],
            failedResources: [{ type: "run", id: "run-42", tool: "get_run" }],
            claimDigest: input.claim.digest,
            policyDigest: input.policy.digest,
            executionProfile: {
              modelRef: "trusted-verifier",
              version: "1.0.0",
              documentDigest: "sha256:verifier",
              closure: "primary_only" as const,
            },
          };
        },
      },
      newId: () => "vd-fail",
      now: () => "2026-08-08T01:00:00.000Z",
    });
    const decision = await svc.requestVerification("acme", "cp-fail");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.detail).toContain("reads FAILED for run:run-42");
    expect(decision.evidenceCoverage).toMatchObject({ offered: 1, reviewed: [] });
  });
});
