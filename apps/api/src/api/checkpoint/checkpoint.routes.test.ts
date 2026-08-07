import { CheckpointService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryHandoffCheckpointStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// Handoff checkpoints over HTTP (ownership protocol O6). The interesting surface is what gets REFUSED:
// a checkpoint whose evidence does not resolve, and a verifier checking work it did itself.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in checkpoint tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

async function build() {
  const runStore = new InMemoryRunStore();
  await runStore.create({
    id: "run-42",
    tenant: "acme",
    caseId: "grader-empty-trace",
    harness: { id: "hermes", version: "1.0.0" },
    status: "succeeded",
    createdBy: "agent:fixer",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: runStore }),
    checkpointService: new CheckpointService({
      store: new InMemoryHandoffCheckpointStore(),
      resolvers: { run: async (tenant, id) => (await runStore.get(id))?.tenant === tenant },
      runCreator: async (tenant, id) => {
        const record = await runStore.get(id);
        return record?.tenant === tenant ? record.createdBy : undefined;
      },
    }),
  });
  return app;
}

const payload = (over: Record<string, unknown> = {}) => ({
  goal: "fix the failing grader",
  currentState: "root cause isolated; fix drafted, tests not yet run",
  confirmedFacts: [{ statement: "the grader throws on empty traces", refs: [{ type: "run", id: "run-42" }] }],
  hypotheses: [{ statement: "the retry path double-frees the compute", confidence: "medium" }],
  actionsTaken: [],
  remainingTasks: ["run the regression suite"],
  validationPlan: "run scorecard sc-7 and compare against sc-6",
  ...over,
});

describe("checkpoint routes", () => {
  it("publishes a checkpoint, stamps its identity, and reads it back", async () => {
    const app = await build();
    const created = await app.inject({ method: "POST", url: "/checkpoints", headers: H, payload: payload() });
    expect(created.statusCode).toBe(201);
    const record = created.json();
    expect(record.id).toBeTruthy(); // stamped by the control plane, never supplied
    expect(record.tenant).toBe("acme");

    const read = await app.inject({ method: "GET", url: `/checkpoints/${record.id}`, headers: H });
    expect(read.statusCode).toBe(200);
    expect(read.json().goal).toBe("fix the failing grader");

    const listed = await app.inject({ method: "GET", url: "/checkpoints", headers: H });
    expect(listed.json().map((c: { id: string }) => c.id)).toEqual([record.id]);
    await app.close();
  });

  it("refuses a 'fact' with no evidence reference — the schema will not let it claim otherwise (400)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/checkpoints",
      headers: H,
      payload: payload({ confirmedFacts: [{ statement: "probably the retry path", refs: [] }] }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses a checkpoint citing a run that does not exist (400)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/checkpoints",
      headers: H,
      payload: payload({
        confirmedFacts: [{ statement: "seen on the old batch", refs: [{ type: "run", id: "run-GONE" }] }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/evidence that does not exist/);
    await app.close();
  });

  it("refuses a verifier checkpoint filed by the actor that executed the run (400)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/checkpoints",
      headers: H,
      payload: payload({ role: "verifier", by: { id: "agent:fixer" } }), // run-42's own executor
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot file a verifier checkpoint/);
    await app.close();
  });

  it("another workspace's checkpoint reads 404 (no existence leak)", async () => {
    const app = await build();
    const created = await app.inject({ method: "POST", url: "/checkpoints", headers: H, payload: payload() });
    const res = await app.inject({
      method: "GET",
      url: `/checkpoints/${created.json().id}`,
      headers: { "x-everdict-tenant": "beta" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 404 when the checkpoint service is not configured", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "GET", url: "/checkpoints", headers: H });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
