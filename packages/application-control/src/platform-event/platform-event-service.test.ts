import type { PlatformEventRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { AgentEventSink } from "../ports/agent-event-sink.js";
import type { PlatformEventStore } from "../ports/platform-event-store.js";
import { PlatformEventService } from "./platform-event-service.js";

function memoryStore(): PlatformEventStore & { rows: PlatformEventRecord[] } {
  const rows: PlatformEventRecord[] = [];
  return {
    rows,
    async append(record) {
      const appended = { ...record, seq: rows.length + 1 } as PlatformEventRecord;
      rows.push(appended);
      return appended;
    },
    async list(tenant, opts) {
      return rows.filter((r) => r.tenant === tenant && (opts?.afterSeq === undefined || r.seq > opts.afterSeq));
    },
    async get(tenant, id) {
      return rows.find((r) => r.tenant === tenant && r.id === id);
    },
  };
}

describe("PlatformEventService", () => {
  it("appends the fact to the log AND pushes it to the agent sink with the same event id", async () => {
    // Given a service with a log and an agent sink
    const store = memoryStore();
    const pushed: unknown[] = [];
    const agentEvents: AgentEventSink = {
      async emit(input) {
        pushed.push(input);
      },
    };
    const service = new PlatformEventService({
      store,
      agentEvents,
      newId: () => "ev-1",
      now: () => "2026-07-28T00:00:00.000Z",
    });

    // When emitting a fact
    const appended = await service.emit({
      workspace: "acme",
      kind: "scorecard.completed",
      subject: { type: "scorecard", id: "sc-1" },
      actor: "user-1",
      payload: { failedCases: 2 },
      message: "Scorecard sc-1 succeeded — 2 failed cases",
      recipient: "user-1",
    });

    // Then the log has it and the sink got the matching envelope
    expect(appended?.seq).toBe(1);
    expect(store.rows[0]).toMatchObject({ id: "ev-1", kind: "scorecard.completed", tenant: "acme" });
    expect(pushed[0]).toMatchObject({
      workspace: "acme",
      recipient: "user-1",
      kind: "scorecard.completed",
      eventId: "ev-1",
      subject: { type: "scorecard", id: "sc-1" },
      payload: { failedCases: 2 },
    });
  });

  it("never throws when a channel fails — the fact emission cannot affect the business result", async () => {
    // Given a log that explodes and a sink that explodes
    const service = new PlatformEventService({
      store: {
        append: async () => {
          throw new Error("db down");
        },
        list: async () => [],
        get: async () => undefined,
      },
      agentEvents: {
        emit: async () => {
          throw new Error("agent unreachable");
        },
      },
    });

    // When emitting — then it resolves without throwing (and without a record, since the append failed)
    await expect(
      service.emit({
        workspace: "acme",
        kind: "run.failed",
        subject: { type: "run", id: "r-1" },
        message: "Run r-1 failed",
      }),
    ).resolves.toBeUndefined();
  });

  it("still pushes to the agent sink when no log is configured (push-only dev mode)", async () => {
    const pushed: unknown[] = [];
    const service = new PlatformEventService({
      agentEvents: {
        async emit(input) {
          pushed.push(input);
        },
      },
      newId: () => "ev-9",
    });

    await service.emit({
      workspace: "acme",
      kind: "run.completed",
      subject: { type: "run", id: "r-1" },
      message: "Run r-1 completed",
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ eventId: "ev-9" });
    expect(await service.list("acme")).toEqual([]);
  });
});
