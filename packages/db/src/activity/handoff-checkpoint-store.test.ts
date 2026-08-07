import type { HandoffCheckpointRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryHandoffCheckpointStore, PgHandoffCheckpointStore } from "./handoff-checkpoint-store.js";

const rec = (over: Partial<HandoffCheckpointRecord> = {}): HandoffCheckpointRecord => ({
  id: "cp-1",
  tenant: "acme",
  goal: "fix the failing grader",
  currentState: "root cause isolated; fix drafted",
  confirmedFacts: [{ statement: "throws on empty traces", refs: [{ type: "run", id: "run-42" }] }],
  hypotheses: [],
  actionsTaken: [],
  openDecisions: [],
  remainingTasks: [],
  requiredCapabilities: [],
  risks: [],
  validationPlan: "run sc-7 against sc-6",
  createdAt: "2026-08-08T00:00:00.000Z",
  createdBy: "agent:fixer:conv-1",
  ...over,
});

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

describe("InMemoryHandoffCheckpointStore", () => {
  it("lists a workspace's handoffs newest first, and narrows to one envelope's", async () => {
    const store = new InMemoryHandoffCheckpointStore();
    await store.create(rec({ id: "old", envelopeId: "env-1", createdAt: "2026-08-01T00:00:00.000Z" }));
    await store.create(rec({ id: "new", envelopeId: "env-2", createdAt: "2026-08-05T00:00:00.000Z" }));
    expect((await store.list("acme")).map((r) => r.id)).toEqual(["new", "old"]);
    expect((await store.list("acme", { envelopeId: "env-1" })).map((r) => r.id)).toEqual(["old"]);
  });

  it("another workspace's checkpoint reads as nonexistent (no existence leak)", async () => {
    const store = new InMemoryHandoffCheckpointStore();
    await store.create(rec());
    expect(await store.get("beta", "cp-1")).toBeUndefined();
    expect(await store.list("beta")).toEqual([]);
    expect(await store.get("acme", "cp-1")).toBeDefined();
  });
});

describe("PgHandoffCheckpointStore", () => {
  it("writes the checkpoint and its fact in ONE statement — the E0 same-tx outbox", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgHandoffCheckpointStore(client).create(rec({ envelopeId: "env-1", role: "executor" }), [
      {
        id: "ev-1",
        tenant: "acme",
        kind: "checkpoint.created",
        subject: { type: "checkpoint", id: "cp-1" },
        payload: {},
        message: "Handoff checkpoint published: fix the failing grader",
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    ]);
    expect(calls).toHaveLength(1); // one statement, two writes — atomicity without a transaction seam
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_handoff_checkpoints/);
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_platform_events/);
    expect(calls[0]?.params?.[2]).toBe("env-1");
    expect(calls[0]?.params?.[3]).toBe("executor");
  });

  it("maps a row back through the record schema, body and columns agreeing", async () => {
    const record = rec({ role: "verifier", by: { id: "agent:checker" } });
    const { client } = fakeClient(() => ({
      rows: [
        {
          id: record.id,
          tenant: record.tenant,
          envelope_id: null,
          role: "verifier",
          goal: record.goal,
          created_by: record.createdBy,
          created_at: new Date(record.createdAt),
          body: JSON.stringify(record),
        },
      ],
    }));
    const read = await new PgHandoffCheckpointStore(client).get("acme", "cp-1");
    expect(read).toEqual(record);
  });
});
