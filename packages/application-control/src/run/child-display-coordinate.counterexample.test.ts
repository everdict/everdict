import type { RunRecord, RuntimeWorkRef, TraceEvent } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../ports/dispatcher.js";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { RunStore } from "../ports/run-store.js";
import { RunService } from "./run-service.js";

// ── A CHILD'S DISPLAY LANE LOOKED UNDER THE ROW ID (arch-review 63, found by the ExecutionId brand) ──
//
// Every live-view read a run offers — the terminal exec, the repo tree, the file read, the screen endpoint,
// the pushed log tail, the live trace — resolves the handle to address through one private helper, and four
// of those call sites spelled its coordinate by hand:
//
//     await this.displayWork(`evd-run-${record.id}`)
//
// Right for a standalone run, whose row id IS inside its execution id. Silently wrong for a scorecard child,
// whose row id is random and whose attempts live under `evd-<batch>-<case>[-t<n>]`. The lookup matched no
// row, `displayWork` answered `undefined`, and every one of those panels fell back to the case-id resolution
// — "the newest job of this case", which is another concurrent trial's whenever a case runs more than once.
// So a user opening the live trace of trial 1 could be shown trial 0's output, and nothing anywhere failed.
//
// The record-level derivation already existed and was correct (`runIdFor`, preferring the stamped column of
// mig 0172). It was simply not what those four call sites called — the shape rule `protocol` L3 names as a
// predicate written twice. It is now `recordExecutionId` in contracts, and the brand is what made the
// hand-spelled string stop compiling.
//
// Seen RED with the four call sites restored to their literal, observed:
//   a child's live trace addressed no handle at all: expected undefined to be 'everdict-c1-t1-live'

const CHILD: RunRecord = {
  // A scorecard child, in the shape the batch driver actually writes: the row id is random, the execution id
  // names the batch, the case and the TRIAL. A fixture that sets them equal cannot see this defect at all
  // (rule `testing`, the ids-all-match rule).
  id: "run_9f3c2a1b",
  executionId: "evd-sc-77-c1-t1",
  parentScorecardId: "sc-77",
  tenant: "acme",
  harness: { id: "cc", version: "1.0.0" },
  caseId: "c1",
  status: "running",
  runtime: "nomad-dev",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

const HANDLE: RuntimeWorkRef = { tenant: "acme", runId: "evd-sc-77-c1-t1", externalJobId: "everdict-c1-t1-live" };

function store(record: RunRecord): RunStore {
  return {
    async create() {},
    async update(_id: string, patch: Partial<RunRecord>) {
      return { ...record, ...patch };
    },
    async get(id: string) {
      return id === record.id ? record : undefined;
    },
    async list() {
      return [record];
    },
    async deleteByScorecard() {
      return 0;
    },
    async countActiveByEnvelope() {
      return 0;
    },
    async inFlightByTenant() {
      return {};
    },
    async liveSessions() {
      return [];
    },
  };
}

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("not under test");
  },
};

// The ledger as the dispatch left it: one attempt, opened under the EXECUTION id, holding the live handle.
const ledgerWithHandle = async () => {
  const attempts = new InMemoryExecutionAttemptStore();
  const { attemptId } = await attempts.open({
    executionId: storedExecutionId("evd-sc-77-c1-t1"),
    tenant: "acme",
    scorecardId: "sc-77",
    caseId: "c1",
    trial: 1,
  });
  await attempts.reserveWork(attemptId, HANDLE);
  return attempts;
};

describe("[R63 COUNTEREXAMPLE] a scorecard child's live view addresses its OWN work", () => {
  const serviceOver = async () => {
    const addressed: Array<RuntimeWorkRef | undefined> = [];
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: store(CHILD),
      attempts: await ledgerWithHandle(),
      readCaseEvents: async (
        _tenant: string,
        _runtimeList: string | undefined,
        _caseId: string,
        work?: RuntimeWorkRef,
      ): Promise<TraceEvent[] | undefined> => {
        addressed.push(work);
        return [];
      },
    });
    return { service, addressed };
  };

  it("passes the handle the ledger holds, not `undefined`", async () => {
    const { service, addressed } = await serviceOver();
    await service.liveTrace(CHILD.id);

    expect(addressed, "the live-trace read never reached the backend at all").toHaveLength(1);
    expect(addressed[0]?.externalJobId, "a child's live trace addressed no handle at all").toBe("everdict-c1-t1-live");
  });

  it("still finds nothing when the ledger genuinely holds nothing", async () => {
    // The control. A resolution that answered a handle for an execution with no attempt row would be worse
    // than the bug it replaces — the display would address someone else's container with our confidence.
    const addressed: Array<RuntimeWorkRef | undefined> = [];
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: store(CHILD),
      attempts: new InMemoryExecutionAttemptStore(),
      readCaseEvents: async (
        _tenant: string,
        _runtimeList: string | undefined,
        _caseId: string,
        work?: RuntimeWorkRef,
      ): Promise<TraceEvent[] | undefined> => {
        addressed.push(work);
        return [];
      },
    });

    await service.liveTrace(CHILD.id);
    expect(addressed[0]).toBeUndefined();
  });

  it("keeps answering for a STANDALONE run, whose coordinate the literal got right", async () => {
    // The regression control in the other direction: the hand-spelled string was correct for the majority
    // case, so a fix that made children work by breaking standalone runs would look green in this file
    // without this test.
    const solo: RunRecord = { ...CHILD, id: "r1", executionId: undefined, parentScorecardId: undefined };
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: storedExecutionId("evd-run-r1"), tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-solo" });

    const addressed: Array<RuntimeWorkRef | undefined> = [];
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: store(solo),
      attempts,
      readCaseEvents: async (
        _tenant: string,
        _runtimeList: string | undefined,
        _caseId: string,
        work?: RuntimeWorkRef,
      ): Promise<TraceEvent[] | undefined> => {
        addressed.push(work);
        return [];
      },
    });

    await service.liveTrace("r1");
    expect(addressed[0]?.externalJobId).toBe("everdict-solo");
  });
});
