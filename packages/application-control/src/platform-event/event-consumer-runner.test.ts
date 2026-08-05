import type { NotificationRecord, PlatformEventRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runFeedConsumer, scorecardFeedConsumer } from "../notification/feed-consumers.js";
import type { EventConsumerStateStore } from "../ports/event-consumer-store.js";
import type { NotificationStore } from "../ports/notification-store.js";
import type { PlatformEventStore } from "../ports/platform-event-store.js";
import { EventConsumerRunner, type PlatformEventConsumer } from "./event-consumer-runner.js";

// In-memory doubles mirroring the @everdict/db impls (the app layer never imports them).
function eventLog(records: Array<Omit<PlatformEventRecord, "seq">>): PlatformEventStore {
  const rows: PlatformEventRecord[] = records.map((r, i) => ({ ...r, seq: i + 1 }) as PlatformEventRecord);
  return {
    async append(record) {
      const appended = { ...record, seq: rows.length + 1 } as PlatformEventRecord;
      rows.push(appended);
      return appended;
    },
    async list() {
      return rows;
    },
    async dailyCounts() {
      return []; // the pulse's aggregate — not what these tests are about
    },
    async listAll(opts) {
      let out = rows.filter((r) => (opts?.afterSeq === undefined ? true : r.seq > opts.afterSeq));
      if (opts?.kinds) out = out.filter((r) => (opts.kinds as string[]).includes(r.kind));
      out = [...out].sort((a, b) => (opts?.order === "desc" ? b.seq - a.seq : a.seq - b.seq));
      return out.slice(0, opts?.limit ?? 100);
    },
    async deleteOlderThan() {
      return 0;
    },
    async get() {
      return undefined;
    },
  };
}

function stateStore() {
  const cursors = new Map<string, number>();
  const deadLetters: Array<{ consumer: string; eventId: string; error: string }> = [];
  const store: EventConsumerStateStore = {
    async getCursor(consumer) {
      return cursors.get(consumer) ?? 0;
    },
    async setCursor(consumer, seq) {
      cursors.set(consumer, seq);
    },
    async recordDeadLetter(input) {
      deadLetters.push({ consumer: input.consumer, eventId: input.eventId, error: input.error });
    },
  };
  return { store, cursors, deadLetters };
}

// An idempotent feed (the same natural-key discipline as the real stores) — the rewind property's substrate.
function feedStore() {
  const rows: NotificationRecord[] = [];
  const store: NotificationStore = {
    async add(record) {
      if (rows.some((r) => r.id === record.id)) return;
      rows.push(record);
    },
    async list() {
      return rows;
    },
    async markRead() {
      return 0;
    },
  };
  return { store, rows };
}

const fact = (over: Partial<PlatformEventRecord>): Omit<PlatformEventRecord, "seq"> => ({
  id: `ev-${over.kind}-${Math.abs(JSON.stringify(over).length)}`,
  tenant: "acme",
  kind: "run.completed",
  subject: { type: "run", id: "r1" },
  actor: "alice",
  payload: { harness: "scripted@0", caseId: "c1" },
  message: "done",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...over,
});

describe("EventConsumerRunner — one log, N durable cursors (E1)", () => {
  it("walks only the subscribed kinds, advances the cursor per event, and reports lag", async () => {
    const { store: state, cursors } = stateStore();
    const events = eventLog([
      fact({ id: "e1", kind: "run.completed" }),
      fact({ id: "e2", kind: "scorecard.submitted", subject: { type: "scorecard", id: "sc1" } }),
      fact({ id: "e3", kind: "run.failed" }),
    ]);
    const handled: string[] = [];
    const runner = new EventConsumerRunner({ events, state });
    runner.register({
      name: "test:runs",
      kinds: ["run.completed", "run.failed"],
      handle: async (e) => void handled.push(e.id),
    });
    await runner.drain();
    expect(handled).toEqual(["e1", "e3"]);
    expect(cursors.get("test:runs")).toBe(3); // past the skipped kind too — the cursor tracks the LOG position
    expect(await runner.lag()).toEqual({ "test:runs": 0 });
  });

  it("a poison event dead-letters after the retry budget and NEVER dams the log", async () => {
    const { store: state, deadLetters } = stateStore();
    const events = eventLog([fact({ id: "bad" }), fact({ id: "good", subject: { type: "run", id: "r2" } })]);
    const handled: string[] = [];
    let attempts = 0;
    const poison: PlatformEventConsumer = {
      name: "test:poison",
      handle: async (e) => {
        if (e.id === "bad") {
          attempts++;
          throw new Error("cannot digest");
        }
        handled.push(e.id);
      },
    };
    const runner = new EventConsumerRunner({ events, state, maxAttempts: 3 });
    runner.register(poison);
    await runner.drain();
    expect(attempts).toBe(3); // the retry budget, immediately
    expect(deadLetters).toEqual([{ consumer: "test:poison", eventId: "bad", error: "cannot digest" }]);
    expect(handled).toEqual(["good"]); // the cursor moved past the poison — one bad fact never blocks the rest
  });

  it("W3 acceptance: a cursor REWIND replays the facts with ZERO duplicate effects (natural-key idempotency)", async () => {
    const { store: state } = stateStore();
    const { store: feed, rows } = feedStore();
    const events = eventLog([
      fact({ id: "e1", kind: "run.completed" }),
      fact({ id: "e2", kind: "run.failed", subject: { type: "run", id: "r2" } }),
      fact({
        id: "e3",
        kind: "scorecard.completed",
        subject: { type: "scorecard", id: "sc1" },
        payload: { dataset: "d@1", harness: "h@1", origin: "schedule" },
      }),
    ]);
    const runner = new EventConsumerRunner({ events, state });
    runner.register(runFeedConsumer(feed));
    runner.register(scorecardFeedConsumer(feed));
    await runner.drain();
    expect(rows).toHaveLength(3);

    // Rewind a day of facts (both cursors to 0) and replay — the effects must not duplicate.
    await state.setCursor("feed:runs", 0);
    await state.setCursor("feed:scorecards", 0);
    await runner.drain();
    expect(rows).toHaveLength(3); // zero duplicates — the nf-<eventId> natural key absorbed the replay
  });
});

describe("feed consumers — parity with the direct-call feed they replaced", () => {
  it("run facts become the exact old feed rows (kind/title/body/link/recipient)", async () => {
    const { store: feed, rows } = feedStore();
    await runFeedConsumer(feed).handle({
      ...fact({ id: "e9", kind: "run.failed" }),
      seq: 1,
    } as PlatformEventRecord);
    expect(rows[0]).toMatchObject({
      id: "nf-e9",
      workspace: "acme",
      recipient: "alice",
      kind: "run_failed",
      title: "Run failed — scripted@0",
      body: "case c1",
      link: { runId: "r1" },
    });
  });

  it("scorecard facts keep the schedule branding (payload.origin === 'schedule')", async () => {
    const { store: feed, rows } = feedStore();
    await scorecardFeedConsumer(feed).handle({
      ...fact({
        id: "e10",
        kind: "scorecard.completed",
        subject: { type: "scorecard", id: "sc1" },
        payload: { dataset: "d@1.0.0", harness: "h@1", origin: "schedule" },
      }),
      seq: 1,
    } as PlatformEventRecord);
    expect(rows[0]).toMatchObject({
      kind: "schedule_completed",
      title: "Scheduled run completed — d@1.0.0 × h@1",
      link: { scorecardId: "sc1" },
    });
    // An actor-less fact (machine-fired — the gate upstream already excludes these) writes nothing.
    const before = rows.length;
    await scorecardFeedConsumer(feed).handle({
      ...fact({ id: "e11", kind: "scorecard.failed", actor: undefined, subject: { type: "scorecard", id: "x" } }),
      seq: 2,
    } as PlatformEventRecord);
    expect(rows).toHaveLength(before);
  });
});
