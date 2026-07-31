import type { AgentTaskRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { AgentTaskStore } from "../ports/agent-task-store.js";
import type { EmitPlatformEventInput } from "../ports/platform-event-emitter.js";
import { TaskService } from "./task-service.js";

// A minimal in-memory store fake (application-control cannot depend on @everdict/db — layering).
function storeFake(): AgentTaskStore & { records: AgentTaskRecord[] } {
  const records: AgentTaskRecord[] = [];
  return {
    records,
    async create(record) {
      records.push(record);
    },
    async get(tenant, id) {
      return records.find((r) => r.tenant === tenant && r.id === id);
    },
    async list(tenant, opts) {
      return records
        .filter((r) => r.tenant === tenant && (opts?.status === undefined || r.status === opts.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async update(tenant, id, patch) {
      const index = records.findIndex((r) => r.tenant === tenant && r.id === id);
      const existing = records[index];
      if (index < 0 || !existing) return undefined;
      const updated = { ...existing, ...patch };
      records[index] = updated;
      return updated;
    },
    async remove(tenant, id) {
      const index = records.findIndex((r) => r.tenant === tenant && r.id === id);
      if (index >= 0) records.splice(index, 1);
    },
  };
}

function service(): { tasks: TaskService; store: ReturnType<typeof storeFake>; emitted: EmitPlatformEventInput[] } {
  const store = storeFake();
  const emitted: EmitPlatformEventInput[] = [];
  let n = 0;
  const tasks = new TaskService({
    store,
    events: {
      emit: async (input) => {
        emitted.push(input);
      },
    },
    newId: () => `t-${n++}`,
    now: () => "2026-07-31T00:00:00.000Z",
  });
  return { tasks, store, emitted };
}

describe("TaskService", () => {
  it("an agent-created task stamps origin + causedBy so the creator never wakes on its own task", async () => {
    const { tasks, emitted } = service();
    const record = await tasks.create({
      tenant: "acme",
      createdBy: "u-1",
      subject: "Run the baseline on web@2.2.0",
      agent: { agentId: "triage-bot", conversationId: "conv-9" },
    });
    expect(record.status).toBe("pending");
    expect(record.origin).toEqual({ agentId: "triage-bot", conversationId: "conv-9" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "task.created",
      subject: { type: "task", id: record.id },
      causedBy: "agent:triage-bot:conv-9",
    });
  });

  it("claiming records the claimer as owner and emits task.claimed; completing emits task.completed", async () => {
    const { tasks, emitted } = service();
    const created = await tasks.create({ tenant: "acme", createdBy: "u-1", subject: "triage the dip" });
    emitted.length = 0;
    // When a member claims it without naming an owner
    const claimed = await tasks.update("acme", created.id, { status: "in_progress" }, { subject: "u-2" });
    expect(claimed.owner).toBe("u-2");
    expect(emitted[0]).toMatchObject({ kind: "task.claimed", actor: "u-2", payload: { owner: "u-2" } });
    // …and completes it — the "dependency cleared" wake signal
    await tasks.update("acme", created.id, { status: "completed" }, { subject: "u-2" });
    expect(emitted[1]).toMatchObject({ kind: "task.completed" });
  });

  it("a same-status patch emits no fact (edits are not lifecycle news)", async () => {
    const { tasks, emitted } = service();
    const created = await tasks.create({ tenant: "acme", createdBy: "u-1", subject: "t" });
    emitted.length = 0;
    await tasks.update("acme", created.id, { description: "more detail", status: "pending" }, { subject: "u-1" });
    expect(emitted).toHaveLength(0);
  });

  it("delete is creator-or-admin only; unknown ids read 404", async () => {
    const { tasks } = service();
    const created = await tasks.create({ tenant: "acme", createdBy: "u-1", subject: "t" });
    await expect(tasks.remove("acme", created.id, { subject: "u-2", isAdmin: false })).rejects.toThrow(/not allowed/);
    await expect(tasks.remove("acme", created.id, { subject: "u-2", isAdmin: true })).resolves.toBeUndefined();
    await expect(tasks.get("acme", created.id)).rejects.toThrow(/not found/);
    await expect(tasks.get("acme", "missing")).rejects.toThrow(/not found/);
  });
});
