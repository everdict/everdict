import { CheckpointService } from "@everdict/application-control";
import { BadRequestError, type HandoffCheckpoint, type RunRecord } from "@everdict/contracts";
import { PgHandoffCheckpointStore, PgRunStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-11.
//
// The invariant: A VERDICT ABOUT WORK NEVER COMES FROM THE ACTOR THAT DID THE WORK, AND A "FACT" ALWAYS HAS
// EVIDENCE THAT EXISTS. A handoff checkpoint is what a successor decides from; both of its admission rules
// are about refusing to record a claim that looks like evidence and is not:
//   • a confirmedFact citing a run nobody can find is a hypothesis wearing a fact's clothes
//   • a verifier checkpoint filed by the actor that executed the run is a claim wearing a second hat
//
// Why only a real database can prove it: both rules are cross-record reads. The service resolves the cited
// run through the run store and asks who created it — so the guard's strength is exactly the strength of that
// lookup against real rows. Wired to fakes, the rule passes whether or not the linkage survives persistence.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust(
  "TRUST-11 — checkpoint admission over real Postgres refuses dangling evidence and self-verification",
  () => {
    let pg: TrustPg;
    let tenant: string;
    let runs: PgRunStore;
    let service: CheckpointService;
    let executedRunId: string;

    const EXECUTOR = "agent:fixer";
    const INDEPENDENT = "agent:reviewer";

    const checkpoint = (
      over: Partial<HandoffCheckpoint> = {},
    ): Omit<HandoffCheckpoint, "id" | "createdAt" | "createdBy"> => ({
      goal: "make the failing case pass",
      currentState: "the patch is applied and the suite has been re-run",
      confirmedFacts: [{ statement: "the suite ran to completion", refs: [{ type: "run", id: executedRunId }] }],
      hypotheses: [],
      actionsTaken: [],
      openDecisions: [],
      remainingTasks: [],
      requiredCapabilities: [],
      risks: [],
      validationPlan: "re-run the case and read the recorded verdict",
      ...over,
    });

    beforeAll(async () => {
      pg = await openTrustPg();
      tenant = trustId("trust-verify");
      runs = new PgRunStore(pg.client);

      // Given: a real run row, created by the EXECUTOR. This row is the linkage every guard below reads.
      executedRunId = trustId("run");
      const record: RunRecord = {
        id: executedRunId,
        tenant,
        harness: { id: "scripted", version: "0" },
        caseId: "c1",
        status: "succeeded",
        createdBy: EXECUTOR,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await runs.create(record);

      service = new CheckpointService({
        store: new PgHandoffCheckpointStore(pg.client),
        // Bound to the real stores, exactly as the composition root binds them.
        resolvers: { run: async (t, id) => (await runs.get(id))?.tenant === t },
        runActor: async (t, id) => {
          const run = await runs.get(id);
          if (run?.tenant !== t || run.createdBy === undefined) return undefined;
          return {
            id: run.createdBy,
            runId: run.id,
            ...(run.group?.id !== undefined ? { sessionId: run.group.id } : {}),
          };
        },
        newId: () => trustId("cp"),
      });
    });

    afterAll(async () => {
      if (tenant) {
        await pg.client.query("DELETE FROM everdict_handoff_checkpoints WHERE tenant = $1", [tenant]);
        await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [tenant]);
      }
      await pg?.close();
    });

    it("the actor that executed the run cannot file a verifier checkpoint about it", async () => {
      // When: the executor files a verdict on its own work.
      const filing = service.create({
        tenant,
        createdBy: EXECUTOR,
        checkpoint: checkpoint({ role: "verifier", by: { id: EXECUTOR } }),
      });

      // Then: refused. Every intra-role rule was satisfied — the only thing wrong is WHO is speaking, which is
      // precisely what makes a self-verified verdict worthless.
      await expect(filing).rejects.toBeInstanceOf(BadRequestError);
      await expect(filing).rejects.toThrow(/cannot verify its own work/);
    });

    it("an independent actor's verifier checkpoint is accepted and is durable", async () => {
      // When: a different actor files the same verdict about the same run.
      const record = await service.create({
        tenant,
        createdBy: INDEPENDENT,
        checkpoint: checkpoint({ role: "verifier", by: { id: INDEPENDENT } }),
      });

      // Then: accepted — and readable back out of Postgres, because a handoff nobody can find is not a handoff.
      expect(record.role).toBe("verifier");
      const reread = await service.get(tenant, record.id);
      expect(reread.by?.id).toBe(INDEPENDENT);
      expect(reread.confirmedFacts[0]?.refs[0]).toEqual({ type: "run", id: executedRunId, resolution: "verified" }); // the admission-time existence check is durable on the record
    });

    it("the executor may still file an EXECUTOR checkpoint about its own run — separation binds verdicts, not reports", async () => {
      // A report claims nothing about somebody else's work, so there is nothing to separate. Certifying this
      // alongside the refusal is what keeps the guard from being over-broad: a rule that also blocked honest
      // handoffs would be quietly worked around.
      const record = await service.create({
        tenant,
        createdBy: EXECUTOR,
        checkpoint: checkpoint({ role: "executor", by: { id: EXECUTOR } }),
      });
      expect(record.role).toBe("executor");
    });

    it("a confirmed fact citing a run that does not exist is refused — evidence that cannot be found is not evidence", async () => {
      const filing = service.create({
        tenant,
        createdBy: INDEPENDENT,
        checkpoint: checkpoint({
          confirmedFacts: [{ statement: "the suite ran", refs: [{ type: "run", id: trustId("ghost") }] }],
        }),
      });
      await expect(filing).rejects.toBeInstanceOf(BadRequestError);
      await expect(filing).rejects.toThrow(/cites evidence that does not exist/);
    });

    it("another workspace's run does not count as evidence — the tenant boundary holds inside the resolver", async () => {
      // Given: a run that exists, but in a different workspace. Resolving by id alone would accept it and leak
      // one workspace's execution into another's evidence chain.
      const otherTenant = trustId("trust-other");
      const foreignRun = trustId("run-foreign");
      await runs.create({
        id: foreignRun,
        tenant: otherTenant,
        harness: { id: "scripted", version: "0" },
        caseId: "c1",
        status: "succeeded",
        createdBy: EXECUTOR,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      try {
        const filing = service.create({
          tenant,
          createdBy: INDEPENDENT,
          checkpoint: checkpoint({
            confirmedFacts: [{ statement: "it ran", refs: [{ type: "run", id: foreignRun }] }],
          }),
        });
        await expect(filing).rejects.toThrow(/cites evidence that does not exist/);
      } finally {
        await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [otherTenant]);
      }
    });
  },
);
