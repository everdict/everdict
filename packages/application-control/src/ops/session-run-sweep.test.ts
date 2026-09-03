import type { RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { LiveSessionQuery, OutboxEvent, RunStore } from "../ports/run-store.js";
import { settleOrphanSessionRuns } from "./session-run-sweep.js";

// Local store double (application-control cannot depend on @everdict/db — layer direction).
function fakeStore() {
  const rows = new Map<string, RunRecord>();
  const factKinds: string[] = [];
  const store: RunStore = {
    async create(record: RunRecord) {
      rows.set(record.id, record);
    },
    async update(id: string, patch: Partial<RunRecord>, events?: OutboxEvent[]) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      factKinds.push(...(events ?? []).map((e) => e.kind));
      return next;
    },
    async get(id: string) {
      return rows.get(id);
    },
    async list() {
      return [...rows.values()];
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
    // No children in this fixture — the queue-progress read is not this test's subject.
    async countChildrenByStatus() {
      return [];
    },
    async liveSessions(query: LiveSessionQuery = {}) {
      return [...rows.values()]
        .filter((r) => r.lifetime === "session" && (r.status === "queued" || r.status === "running"))
        .filter((r) => query.trigger === undefined || r.trigger === query.trigger)
        .map((r) => ({
          id: r.id,
          tenant: r.tenant,
          ...(r.session?.expiresAt !== undefined ? { expiresAt: r.session.expiresAt } : {}),
        }));
    },
  };
  return { store, rows, factKinds };
}

const sessionRun = (id: string, trigger: string, expiresAt: string): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "img", version: "adhoc" },
  caseId: "img",
  status: "running",
  kind: "sandbox",
  lifetime: "session",
  trigger,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  session: { image: "img", ttlSec: 300, expiresAt },
});

describe("settleOrphanSessionRuns (the lane-independent ledger sweep)", () => {
  it("settles running session rows past deadline+grace as orphaned, and leaves excluded lanes to their own sweep", async () => {
    // Regression: a control plane whose sandbox/browser lane is NOT configured still shares the ledger —
    // a row another (dead) process wrote sat `running` forever because no configured lane could end it.
    const { store, factKinds } = fakeStore();
    await store.create(sessionRun("dead-sandbox", "sandbox", "2026-08-06T00:05:00.000Z"));
    await store.create(sessionRun("dead-browser", "browser", "2026-08-06T00:05:00.000Z"));
    await store.create(sessionRun("owned-lane", "sandbox", "2026-08-06T00:05:00.000Z"));
    await store.create(sessionRun("still-live", "sandbox", "2026-08-06T09:00:00.000Z"));

    const settled = await settleOrphanSessionRuns({
      store,
      excludeTriggers: [], // no lane configured — everything overdue is ours
      now: () => "2026-08-06T01:00:00.000Z",
    });
    expect(settled).toBe(3); // both dead rows + owned-lane (no exclusion in this pass)
    expect((await store.get("dead-sandbox"))?.session?.closedReason).toBe("orphaned");
    expect((await store.get("dead-browser"))?.status).toBe("succeeded");
    expect((await store.get("still-live"))?.status).toBe("running"); // inside its deadline
    expect(factKinds.length).toBeGreaterThan(0); // the settle rides the E0 outbox like every transition

    // A lane that runs its own sweep keeps its rows: exclusion respected, second pass is idempotent.
    const second = fakeStore();
    await second.store.create(sessionRun("their-lane", "sandbox", "2026-08-06T00:05:00.000Z"));
    expect(
      await settleOrphanSessionRuns({
        store: second.store,
        excludeTriggers: ["sandbox"],
        now: () => "2026-08-06T01:00:00.000Z",
      }),
    ).toBe(0);
    expect((await second.store.get("their-lane"))?.status).toBe("running");
  });

  it("respects the grace window past the deadline (the owning process gets to finish its normal close first)", async () => {
    const { store } = fakeStore();
    await store.create(sessionRun("just-expired", "sandbox", "2026-08-06T00:59:30.000Z"));
    expect(await settleOrphanSessionRuns({ store, excludeTriggers: [], now: () => "2026-08-06T01:00:00.000Z" })).toBe(
      0,
    );
    expect((await store.get("just-expired"))?.status).toBe("running");
  });
});
