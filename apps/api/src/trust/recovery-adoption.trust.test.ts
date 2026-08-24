import { storedExecutionId } from "@everdict/contracts";
import { PgExecutionAttemptStore, PgScorecardStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-178.
//
// A TRANSITION CALLED INSIDE A TRANSACTION IS NOT A TRANSITION THAT HAPPENED (arch-review 66 P0-protocol).
//
// The previous wave put both contributing attempts inside the settlement transaction, which is the right
// structure and the reason it read as finished. What it does with the answer is nothing:
//
//     await boundAttempts.transition(contributing.agent, "committed", { childRunId: c.id });
//
// `transition` is a guarded UPDATE, and its `committed` arm carries `PARENT_AUTHORIZES` — which requires
// `parent.owner_epoch = a.driver_epoch`. A boot recovery RAISES the parent's epoch when it claims the batch
// (`claimOwnership`, the fencing token that stops the replica it declared dead). So every attempt a recovery
// adopts was opened under the epoch BEFORE the claim, and every `committed` it writes is refused — while the
// canonical outcome commits on top:
//
//     child           succeeded
//     receipt         committed
//     agent attempt   active / executing      ← for compute already reclaimed
//     verifier attempt verdict_produced
//
// THIS IS A REAL-POSTGRES SCENARIO BY NECESSITY. `PARENT_AUTHORIZES` is a SQL join against the scorecard
// table; the in-memory twin has no parent to join to and answers `true`, so every unit covering this path
// passed while the production adapter refused every one of these writes (rule `testing`).
//
// Seen RED before the adoption verb existed, observed:
//   the recovery could not adopt the attempt it settled: expected 'executing' to be 'committed'
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-178 — a recovery adopts the attempts it settles, or it settles nothing", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => {
    await pg?.close();
  });

  // The world a boot recovery wakes into: a batch whose owner died mid-flight, and the two physical attempts
  // its dispatch opened under the epoch that was current THEN.
  const worldBeforeRecovery = async () => {
    const attempts = new PgExecutionAttemptStore(pg.client);
    const scorecards = new PgScorecardStore(pg.client);
    const scorecardId = trustId("sc");
    const executionId = storedExecutionId(`evd-${scorecardId}-c1`);

    await scorecards.create({
      id: scorecardId,
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1" },
      status: "running",
      ownerReplica: "cp-dead",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    } as never);
    // The epoch the DEAD driver held, read from the row rather than assumed — `create` does not carry one, so
    // a hand-picked number here would make every attempt below fail its reservation for a reason that has
    // nothing to do with adoption (which is exactly how the first draft of this file went red).
    const openingEpoch = (await scorecards.get(scorecardId))?.ownerEpoch ?? 0;

    // Opened under the DEAD driver's epoch — honest provenance, and until this change also the only number
    // the adoption guard would accept.
    const agent = await attempts.open({
      executionId,
      tenant: "acme",
      scorecardId,
      caseId: "c1",
      driverEpoch: openingEpoch,
    });
    const verifier = await attempts.open({
      executionId,
      tenant: "acme",
      scorecardId,
      caseId: "c1#verify",
      driverEpoch: openingEpoch,
    });
    await attempts.reserveWork(agent.attemptId, {
      tenant: "acme",
      runId: executionId,
      externalJobId: "everdict-c1-agent",
      attemptId: agent.attemptId,
    });
    await attempts.transition(agent.attemptId, "executing");
    await attempts.reserveWork(verifier.attemptId, {
      tenant: "acme",
      runId: executionId,
      externalJobId: "everdict-c1-verify",
      attemptId: verifier.attemptId,
    });
    await attempts.transition(verifier.attemptId, "verdict_produced");

    return { attempts, scorecards, scorecardId, executionId, agent, verifier, openingEpoch };
  };

  const stateOf = async (attempts: PgExecutionAttemptStore, executionId: string, attemptId: string) =>
    (await attempts.list(storedExecutionId(executionId))).find((a) => a.attemptId === attemptId)?.state;

  it("ADOPTS an attempt whose parent epoch moved under it — the claim is why we are here", async () => {
    const { attempts, scorecards, scorecardId, executionId, agent, verifier, openingEpoch } =
      await worldBeforeRecovery();

    // The recovery's claim: the fencing token rises, which is the whole point of claiming.
    const claimed = await scorecards.update(scorecardId, { updatedAt: "2026-08-24T00:00:01.000Z" }, undefined, {
      claimOwnership: true,
    });
    expect(claimed?.ownerEpoch, "the claim did not raise the epoch, so this scenario measures nothing").toBe(
      openingEpoch + 1,
    );

    // The plain transition is what the settlement used to call, and Postgres refuses it — pinned here so the
    // adoption verb below is doing something the old call could not.
    expect(
      await attempts.transition(agent.attemptId, "committed"),
      "the plain committed transition was accepted, so this file no longer describes the defect",
    ).toBe(false);

    const adopted = await attempts.adoptAtSettlement(agent.attemptId, {
      parent: { kind: "scorecard", id: scorecardId, adoptingEpoch: openingEpoch + 1 },
      expectedExecutionId: executionId,
      childRunId: "child-1",
    });
    expect(adopted.kind, "the recovery could not adopt the attempt it settled").toBe("adopted");
    expect(await stateOf(attempts, executionId, agent.attemptId)).toBe("committed");

    const verifierAdopted = await attempts.adoptAtSettlement(verifier.attemptId, {
      parent: { kind: "scorecard", id: scorecardId, adoptingEpoch: openingEpoch + 1 },
      expectedExecutionId: executionId,
    });
    expect(verifierAdopted.kind, "the verdict's own row was left waiting for a case that settled").toBe("adopted");
    expect(await stateOf(attempts, executionId, verifier.attemptId)).toBe("committed");
  });

  it("is IDEMPOTENT — a retried settlement reports already_adopted, not a refusal", async () => {
    const { attempts, scorecards, scorecardId, executionId, agent, openingEpoch } = await worldBeforeRecovery();
    await scorecards.update(scorecardId, { updatedAt: "2026-08-24T00:00:01.000Z" }, undefined, {
      claimOwnership: true,
    });
    const parent = { kind: "scorecard" as const, id: scorecardId, adoptingEpoch: openingEpoch + 1 };

    expect((await attempts.adoptAtSettlement(agent.attemptId, { parent, expectedExecutionId: executionId })).kind).toBe(
      "adopted",
    );
    const again = await attempts.adoptAtSettlement(agent.attemptId, { parent, expectedExecutionId: executionId });
    expect(again.kind, "a retried settlement read its own success as a refusal and aborted").toBe("already_adopted");
  });

  it("REFUSES an attempt another authority already terminalized, naming the state", async () => {
    // The arm that matters most: `false` used to mean this AND the epoch case AND idempotency all at once, so
    // a settlement could not tell "somebody else already did this" from "this attempt may not be adopted".
    const { attempts, scorecards, scorecardId, executionId, agent, openingEpoch } = await worldBeforeRecovery();
    await scorecards.update(scorecardId, { updatedAt: "2026-08-24T00:00:01.000Z" }, undefined, {
      claimOwnership: true,
    });
    await attempts.transition(agent.attemptId, "superseded");

    const refused = await attempts.adoptAtSettlement(agent.attemptId, {
      parent: { kind: "scorecard", id: scorecardId, adoptingEpoch: openingEpoch + 1 },
      expectedExecutionId: executionId,
    });
    expect(refused.kind, "a superseded attempt was adopted as the case's answer").toBe("incompatible_state");
    if (refused.kind !== "incompatible_state") return;
    expect(refused.state).toBe("superseded");
  });

  it("REFUSES when the adopting authority is not the parent's current one", async () => {
    // A stale recovery — its claim lost to another replica's — must not adopt: the batch is being driven by
    // somebody else now, and this is the fence that says so.
    const { attempts, scorecards, scorecardId, executionId, agent, openingEpoch } = await worldBeforeRecovery();
    await scorecards.update(scorecardId, { updatedAt: "2026-08-24T00:00:01.000Z" }, undefined, {
      claimOwnership: true,
    });

    const stale = await attempts.adoptAtSettlement(agent.attemptId, {
      parent: { kind: "scorecard", id: scorecardId, adoptingEpoch: openingEpoch },
      expectedExecutionId: executionId,
    });
    expect(stale.kind, "a recovery whose claim lost still adopted the case's attempts").toBe("wrong_parent");
  });

  it("REFUSES an attempt belonging to another execution, and says absent for one that is gone", async () => {
    const { attempts, scorecards, scorecardId, executionId, agent, openingEpoch } = await worldBeforeRecovery();
    await scorecards.update(scorecardId, { updatedAt: "2026-08-24T00:00:01.000Z" }, undefined, {
      claimOwnership: true,
    });
    const parent = { kind: "scorecard" as const, id: scorecardId, adoptingEpoch: openingEpoch + 1 };

    const wrongExecution = await attempts.adoptAtSettlement(agent.attemptId, {
      parent,
      expectedExecutionId: storedExecutionId("evd-someone-else-c1"),
    });
    expect(wrongExecution.kind, "an attempt from another execution was adopted as this case's").toBe("wrong_parent");

    const missing = await attempts.adoptAtSettlement(`${executionId}#g99`, {
      parent,
      expectedExecutionId: executionId,
    });
    expect(missing.kind, "a row that does not exist was reported as adopted").toBe("absent");
  });
});

// Trust suite — TRUST-179.
//
// THE ATTEMPT MINT CONVERGES FOR N OPENERS, NOT TWO (arch-review 66 P1-adapter).
//
// `open` computes `MAX(generation)+1` and claims it in ONE statement, so the UNIQUE constraint arbitrates —
// which is right. What was wrong is what it did with a second refusal: it retried exactly once, on the
// reasoning that "a second collision means something other than a race".
//
// Three concurrent openers of one execution is not exotic — tail speculation, a spillover duplicate and a
// retry overlap by design. A, B and C all try N+1; A wins; B and C both retry N+2; B wins; and C's second
// collision, an ordinary race, became a store fault that failed a dispatch with nothing wrong with it.
//
// Driven against the real database over independent connections, because the arbiter IS the constraint.
//
// Seen RED with the single retry, observed:
//   a concurrent opener was refused an ordinal that was free: execution attempt was not opened … 23505
describeTrust("TRUST-179 — concurrent openers of one execution all get their own generation", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => {
    await pg?.close();
  });

  it("gives FIVE simultaneous openers five distinct generations", async () => {
    const attempts = new PgExecutionAttemptStore(pg.client);
    const executionId = storedExecutionId(`evd-${trustId("mint")}-c1`);

    const opened = await Promise.all(
      Array.from({ length: 5 }, () => attempts.open({ executionId, tenant: "acme", caseId: "c1" })),
    );

    const generations = opened.map((o) => o.generation).sort((a, b) => a - b);
    expect(generations, "a concurrent opener was refused an ordinal that was free").toEqual([1, 2, 3, 4, 5]);
    expect(new Set(opened.map((o) => o.attemptId)).size, "two openers were handed the same attempt id").toBe(5);
  });
});
