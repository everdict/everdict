import type {
  IssueGroupBy,
  IssueGroupCount,
  IssuePage,
  IssueRecord,
  NotificationRecord,
  PlatformEventRecord,
  ScorecardRecord,
} from "@everdict/contracts";
import { issueCountsByGroup, issueSummaryOf } from "@everdict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { IssueListFilter, IssuePageFilter, IssueStore } from "../ports/issue-store.js";
import type { NotificationStore } from "../ports/notification-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import {
  type ScorecardGroupBy,
  type ScorecardGroupCount,
  type ScorecardListFilter,
  type ScorecardStore,
  countScorecardGroups,
} from "../ports/scorecard-store.js";
import { IssueService } from "./issue-service.js";
import { regressionWatch } from "./regression-watch.js";

// Teams are a peer concern: an issue is numbered by its team, and the tests only need that to be deterministic.
const numberAllocator = (() => {
  let n = 0;
  return {
    async allocateForIssue() {
      n += 1;
      return { number: n, identifier: `EVD-${n}` };
    },
  };
})();

const RESOLVED_AT = "2026-07-01T00:00:00.000Z";
const NOW = "2026-07-31T00:00:00.000Z";

class FakeIssueStore implements IssueStore {
  readonly byId = new Map<string, IssueRecord>();
  readonly events: OutboxEvent[] = [];

  async create(record: IssueRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }
  async get(tenant: string, id: string): Promise<IssueRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }
  async getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined> {
    return [...this.byId.values()].find((r) => r.tenant === tenant && r.identifier === identifier);
  }
  async getByGithub(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return [...this.byId.values()].filter(
      (r) =>
        r.tenant === tenant &&
        (filter?.status === undefined || r.status === filter.status) &&
        (filter?.link === undefined || r.links.some((l) => l.type === filter.link?.type && l.id === filter.link.id)),
    );
  }
  // Derived from this fake's own `list` via the kernel helpers, so it cannot disagree with production.
  async listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage> {
    return { items: (await this.list(tenant, filter)).map(issueSummaryOf) };
  }
  async countByGroup(tenant: string, groupBy: IssueGroupBy, filter?: IssueListFilter): Promise<IssueGroupCount[]> {
    return issueCountsByGroup(await this.list(tenant, filter), groupBy);
  }
  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }
  async remove(tenant: string, id: string): Promise<void> {
    this.byId.delete(id);
  }
}

class FakeScorecardStore implements ScorecardStore {
  readonly byId = new Map<string, ScorecardRecord>();
  async create(record: ScorecardRecord): Promise<void> {
    this.byId.set(record.id, record);
  }
  async update(): Promise<ScorecardRecord | undefined> {
    return undefined;
  }
  async get(id: string): Promise<ScorecardRecord | undefined> {
    return this.byId.get(id);
  }
  async list(_tenant?: string, _filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    return [...this.byId.values()];
  }
  async delete(): Promise<boolean> {
    return true;
  }
  // Counts the SAME rows this double's own `list` answers, through the one shared counter — a double that
  // answered `[]` here while holding rows would disagree with itself.
  async countByGroup(
    tenant: string | undefined,
    groupBy: ScorecardGroupBy,
    filter?: ScorecardListFilter,
  ): Promise<ScorecardGroupCount[]> {
    return countScorecardGroups(await this.list(tenant, filter), groupBy);
  }
}

class FakeFeed implements NotificationStore {
  readonly rows = new Map<string, NotificationRecord>();
  async add(record: NotificationRecord): Promise<void> {
    if (!this.rows.has(record.id)) this.rows.set(record.id, record); // natural-key idempotence, like the real store
  }
  async list(): Promise<NotificationRecord[]> {
    return [...this.rows.values()];
  }
  async markRead(): Promise<number> {
    return 0;
  }
  async remove(_workspace: string, id: string): Promise<void> {
    this.rows.delete(id);
  }
  async countUnread(): Promise<number> {
    return 0;
  }
}

// A scorecard whose two cases yield the given pass rate (0, 0.5 or 1). Only the fields the watch reads are
// meaningful; the rest satisfy the record's shape.
function scorecard(
  id: string,
  over: {
    passes: number;
    createdAt: string;
    harnessVersion?: string;
    datasetVersion?: string;
    subset?: ScorecardRecord["subset"];
  },
): ScorecardRecord {
  const harness = `web-agent@${over.harnessVersion ?? "2.0.0"}`;
  return {
    id,
    tenant: "acme",
    ...(over.subset ? { subset: over.subset } : {}),
    dataset: { id: "regression-suite", version: over.datasetVersion ?? "1.0.0" },
    harness: { id: "web-agent", version: over.harnessVersion ?? "2.0.0" },
    status: "succeeded",
    // The persisted aggregate is what the watch reads now (decisionPassRate — arch-review 43): the embed
    // below is inert extra shape. Every production batch is child-backed and carries NO embed at all.
    summary: [{ metric: "tests_pass", count: 2, mean: over.passes / 2, passRate: over.passes / 2 }],
    scorecard: {
      harness,
      suiteId: "regression-suite",
      results: Array.from({ length: 2 }, (_, i) => ({
        caseId: `c${i}`,
        harness,
        trace: [],
        snapshot: { kind: "repo" as const, diff: "", changedFiles: [], headSha: "abc" },
        // caseVerdict reads `pass` (the ground-truth verdict), not the raw value.
        scores: [{ graderId: "tests", metric: "tests_pass", value: i < over.passes ? 1 : 0, pass: i < over.passes }],
      })),
    },
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
  };
}

function completedEvent(scorecardId: string, id = "ev-1"): PlatformEventRecord {
  return {
    id,
    seq: 1,
    tenant: "acme",
    kind: "scorecard.completed",
    subject: { type: "scorecard", id: scorecardId },
    actor: "dana",
    payload: {},
    message: "done",
    createdAt: NOW,
  };
}

describe("regressionWatch", () => {
  let issues: FakeIssueStore;
  let scorecards: FakeScorecardStore;
  let feed: FakeFeed;

  function watcher() {
    return regressionWatch({
      issues,
      issueService: new IssueService({ store: issues, scorecards, numbers: numberAllocator, now: () => NOW }),
      scorecards,
      feed,
    });
  }

  async function resolvedIssue(over: Partial<IssueRecord> = {}): Promise<IssueRecord> {
    const record: IssueRecord = {
      id: "iss-1",
      tenant: "acme",
      number: 1,
      identifier: "EVD-1",
      formerIdentifiers: [],
      title: "Agent drops the tool result on retry",
      status: "done",
      priority: "none",
      labelIds: [],
      links: [
        { type: "dataset", id: "regression-suite", addedBy: "dana", addedAt: RESOLVED_AT },
        { type: "harness", id: "web-agent", addedBy: "dana", addedAt: RESOLVED_AT },
      ],
      resolution: { scorecardId: "sc-baseline", by: "dana", at: RESOLVED_AT },
      history: [],
      createdBy: "dana",
      createdAt: RESOLVED_AT,
      updatedAt: RESOLVED_AT,
      ...over,
    };
    await issues.create(record);
    return record;
  }

  beforeEach(async () => {
    issues = new FakeIssueStore();
    scorecards = new FakeScorecardStore();
    feed = new FakeFeed();
    await scorecards.create(scorecard("sc-baseline", { passes: 2, createdAt: RESOLVED_AT }));
  });

  it("reopens a resolved issue as regressed when a later batch scores lower, and says by how much", async () => {
    await resolvedIssue({ assignee: "eve" });
    await scorecards.create(scorecard("sc-new", { passes: 1, createdAt: NOW }));

    await watcher().handle(completedEvent("sc-new"));

    const after = await issues.get("acme", "iss-1");
    expect(after?.status).toBe("regressed");
    expect(after?.resolution?.scorecardId).toBe("sc-baseline"); // the baseline it fell FROM is preserved
    expect(after?.history.at(-1)).toMatchObject({ event: "reopened", detail: { cause: "regression" } });

    const fact = issues.events.find((e) => e.kind === "issue.status_changed");
    expect(fact?.payload).toMatchObject({ from: "done", to: "regressed", cause: "regression", scorecardId: "sc-new" });
    // Not an agent — the causedBy loop-guard prefix must stay honest.
    expect(fact?.causedBy).toBeUndefined();

    const bell = await feed.list();
    expect(bell.map((n) => n.recipient).sort()).toEqual(["dana", "eve"]);
    expect(bell[0]).toMatchObject({ kind: "issue_regressed", link: { resourceType: "issue", resourceId: "iss-1" } });
    expect(bell[0]?.body).toContain("100%");
    expect(bell[0]?.body).toContain("50%");
  });

  it("a partial (subset) rerun never reopens — a 2-case rerun's rate is not the guarantee's rate", async () => {
    await resolvedIssue();
    await scorecards.create(scorecard("sc-partial", { passes: 0, createdAt: NOW, subset: { total: 50, selected: 2 } }));

    await watcher().handle(completedEvent("sc-partial"));

    expect((await issues.get("acme", "iss-1"))?.status).toBe("done"); // untouched
  });

  it("a different DATASET version cannot reopen — a different case set is not the same comparison", async () => {
    await resolvedIssue();
    await scorecards.create(scorecard("sc-newds", { passes: 0, createdAt: NOW, datasetVersion: "2.0.0" }));

    await watcher().handle(completedEvent("sc-newds"));

    expect((await issues.get("acme", "iss-1"))?.status).toBe("done"); // untouched
  });

  it("fires across a harness VERSION bump — that is exactly the drop worth catching", async () => {
    await resolvedIssue();
    await scorecards.create(scorecard("sc-new", { passes: 0, createdAt: NOW, harnessVersion: "3.0.0" }));
    await watcher().handle(completedEvent("sc-new"));
    expect((await issues.get("acme", "iss-1"))?.status).toBe("regressed");
  });

  it("stays silent when the score held, improved, or the batch predates the resolution", async () => {
    await resolvedIssue();
    await scorecards.create(scorecard("sc-equal", { passes: 2, createdAt: NOW }));
    await scorecards.create(scorecard("sc-old", { passes: 0, createdAt: "2026-06-01T00:00:00.000Z" }));

    await watcher().handle(completedEvent("sc-equal"));
    expect((await issues.get("acme", "iss-1"))?.status).toBe("done");

    await watcher().handle(completedEvent("sc-old", "ev-2"));
    expect((await issues.get("acme", "iss-1"))?.status).toBe("done"); // a late-arriving old batch is not news
    expect(await feed.list()).toEqual([]);
  });

  it("is idempotent under redelivery — the second pass finds the issue no longer done", async () => {
    await resolvedIssue();
    await scorecards.create(scorecard("sc-new", { passes: 1, createdAt: NOW }));
    const watch = watcher();
    await watch.handle(completedEvent("sc-new"));
    await watch.handle(completedEvent("sc-new"));
    expect(issues.events.filter((e) => e.kind === "issue.status_changed")).toHaveLength(1);
    expect(await feed.list()).toHaveLength(1);
  });

  it("ignores issues that do not watch BOTH the dataset and the harness, or that closed without evidence", async () => {
    await resolvedIssue({
      id: "iss-dataset-only",
      links: [{ type: "dataset", id: "regression-suite", addedBy: "dana", addedAt: RESOLVED_AT }],
    });
    await resolvedIssue({
      id: "iss-no-evidence",
      links: [
        { type: "dataset", id: "regression-suite", addedBy: "dana", addedAt: RESOLVED_AT },
        { type: "harness", id: "web-agent", addedBy: "dana", addedAt: RESOLVED_AT },
      ],
      resolution: { note: "closed by hand", by: "dana", at: RESOLVED_AT },
    });
    await scorecards.create(scorecard("sc-new", { passes: 0, createdAt: NOW }));

    await watcher().handle(completedEvent("sc-new"));
    expect((await issues.get("acme", "iss-dataset-only"))?.status).toBe("done");
    expect((await issues.get("acme", "iss-no-evidence"))?.status).toBe("done");
  });

  it("a CHILD-BACKED batch (runIds, no embedded plane — the production shape) still reopens (arch-review 43)", async () => {
    // Pre-fix the watch read `record.scorecard` off the raw store row; a child-backed batch deliberately
    // persists no embed, so the watch computed no rate and silently never fired — for every normal batch.
    await resolvedIssue();
    const { scorecard: _plane, ...bare } = scorecard("sc-regressed", { passes: 0, createdAt: NOW });
    const childBacked: ScorecardRecord = { ...bare, runIds: ["child-1", "child-2"] };
    await scorecards.create(childBacked);
    await watcher().handle(completedEvent("sc-regressed"));
    expect(issues.byId.get("iss-1")?.status).toBe("regressed");
  });

  it("never treats the resolution scorecard itself as a regression", async () => {
    await resolvedIssue();
    await watcher().handle(completedEvent("sc-baseline"));
    expect((await issues.get("acme", "iss-1"))?.status).toBe("done");
  });
});
