import type { RunRecord, RunUsageSummary } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../ports/dispatcher.js";
import type { RunStore } from "../ports/run-store.js";
import type {
  SealedTrajectory,
  TrajectoryEventsResult,
  TrajectoryStore,
  TrajectoryUsage,
} from "../ports/trajectory-store.js";
import { RunService } from "./run-service.js";

// ── THE COST BADGE READ THE WHOLE TRAJECTORY (long-horizon OOM) ─────────────────────────────────────
//
// `RunService.get` fills a run's usage from the sealed trajectory when the record carries no embedded
// result — which is every agent turn, since O10 those write refs rather than embeds. It did that by
// fetching the WHOLE sealed trajectory and folding `usageFromTrace` over `sealed.events`:
//
//     const sealed = await this.deps.trajectories.get(record.tenant, record.id).catch(() => undefined);
//     const usage = usageFromTrace(sealed.events);
//
// For a long-horizon run — hundreds of turns, tool results carrying file dumps, artifacts — that body is
// hundreds of megabytes of jsonb. It is detoasted by Postgres, shipped to the API, turned into a JS object
// graph by pg's `JSON.parse`, and then copied ENTIRELY A SECOND TIME by the Zod array parse in `bodyOf`
// before a single number is read from it. Five numbers came out; the rest was garbage the collector had to
// be alive to collect.
//
// The heap it spent is not the asking tenant's. It is the shared control-plane process, so opening one
// workspace's long-horizon run detail page ended every other workspace's in-flight request with it. That is
// the same availability shape arch-review 72 closed one level up, where a single legacy campaign row took
// down a whole workspace's list — here it takes down the deployment.
//
// The repair is rule `protocol` L3 applied to a number: the WRITER derives usage at seal, where it already
// holds the events exactly once, and the reader asks the store for the answer instead of for the evidence.
//
// SEEN RED with `withTrajectoryUsage` restored to the `get`-then-fold form, observed:
//   a body was read to answer a five-number summary: expected [ 'run_agent_turn' ] to deeply equal []

const TURN: RunRecord = {
  // The shape that hurts: a settled agent turn with NO embedded result, so the usage lane is the trajectory
  // one. A fixture carrying a `result` would take the early return and prove nothing at all.
  id: "run_agent_turn",
  tenant: "acme",
  harness: { id: "default", version: "1.0.0" },
  caseId: "conversation-7",
  status: "succeeded",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:30.000Z",
};

const SEALED_USAGE: RunUsageSummary = {
  promptTokens: 812_004,
  completionTokens: 43_119,
  totalTokens: 855_123,
  usd: 12.47,
  calls: 631,
};

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

// The evidence ledger with a tripwire on the expensive door. `get` is the read that hauls every plane's body;
// this double RECORDS the attempt and then behaves exactly as the pre-fix code's `.catch(() => undefined)`
// would have swallowed — so a regression fails on the recording rather than on an exception the production
// code eats. `usage` answers the way a real store answers a row sealed with its summary.
function ledger(answer: TrajectoryUsage): { store: TrajectoryStore; bodyReads: string[] } {
  const bodyReads: string[] = [];
  return {
    bodyReads,
    store: {
      async seal() {
        throw new Error("not under test");
      },
      async planes(): Promise<SealedTrajectory | undefined> {
        // Cheap by construction — headers only. Not the tripwire.
        return undefined;
      },
      // THE EXPENSIVE DOOR. Every byte of evidence leaves the store through here, so a usage read that
      // touches it is the defect this file exists to refuse — whatever shape the read has today.
      async events(_tenant: string, runId: string): Promise<TrajectoryEventsResult> {
        bodyReads.push(runId);
        return { kind: "absent" };
      },
      async usage() {
        return answer;
      },
      async list() {
        return { items: [] };
      },
      async ingestedSince() {
        return { trajectories: 0, events: 0 };
      },
      async deleteOlderThan() {
        return 0;
      },
      // No offload in this fixture, so there is nothing to enumerate — the honest answer, not a stub.
      async expiredRuns() {
        return [];
      },
      async deleteRuns() {
        return 0;
      },
      async payloadRefsOlderThan() {
        return [];
      },
    },
  };
}

describe("[OOM COUNTEREXAMPLE] a run's cost is answered without reading its trajectory", () => {
  it("reports the sealed usage and never opens a body", async () => {
    const { store: trajectories, bodyReads } = ledger({ kind: "derived", usage: SEALED_USAGE });
    const service = new RunService({ dispatcher: unusedDispatcher, store: store(TURN), trajectories });

    const read = await service.get(TURN.id);

    expect(read?.usage, "the run detail reported no usage at all").toEqual(SEALED_USAGE);
    expect(bodyReads, "a body was read to answer a five-number summary").toEqual([]);
  });

  it("shows nothing — and still reads nothing — when the ledger cannot say what it cost", async () => {
    // The control, and the arm that makes the union worth having. A trajectory sealed before the derivation
    // existed is not a trajectory that cost nothing, and the repair for that is `scripts/live/
    // backfill-trajectory-usage.mjs` — never a read that falls back to the body, which would restore the
    // defect for exactly the oldest and largest rows in the store.
    const { store: trajectories, bodyReads } = ledger({ kind: "unknown", reason: "sealed_before_derivation" });
    const service = new RunService({ dispatcher: unusedDispatcher, store: store(TURN), trajectories });

    const read = await service.get(TURN.id);

    expect(read?.usage, "an underivable cost was rendered as a number").toBeUndefined();
    expect(bodyReads, "`unknown` fell back to reading the body — the defect, on the worst rows").toEqual([]);
  });

  it("attaches nothing when the trajectory holds no llm_call at all", async () => {
    // `calls > 0` is the pre-existing rule and it must survive the move: a sealed shell session has real,
    // derived, empty economics, and showing "$0.00 · 0 tokens" on it is noise rather than evidence.
    const empty: RunUsageSummary = { promptTokens: 0, completionTokens: 0, totalTokens: 0, usd: 0, calls: 0 };
    const { store: trajectories } = ledger({ kind: "derived", usage: empty });
    const service = new RunService({ dispatcher: unusedDispatcher, store: store(TURN), trajectories });

    expect((await service.get(TURN.id))?.usage).toBeUndefined();
  });
});
