import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryTrajectoryStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme" };

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in trajectory tests");
  },
};

async function build() {
  const trajectoryStore = new InMemoryTrajectoryStore();
  for (const [runId, tenant] of [
    ["r1", "acme"],
    ["r2", "acme"],
    ["r3", "acme"],
    ["r9", "rival"],
  ] as const) {
    await trajectoryStore.seal({ runId, tenant, source: "run", events: [{ t: 0, kind: "llm_call", model: "m" }] });
  }
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    trajectoryStore,
  });
  return { app };
}

describe("GET /trajectories — browsing the owned evidence ledger (N1 look-inward)", () => {
  it("lists the workspace's sealed metas newest-first and walks pages by cursor — never another tenant's", async () => {
    const { app } = await build();
    const first = await app.inject({ method: "GET", url: "/trajectories?limit=2", headers: H });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]).toMatchObject({ source: "run", eventCount: 1 });
    expect(page1.nextCursor).toBeDefined();

    const second = await app.inject({
      method: "GET",
      url: `/trajectories?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      headers: H,
    });
    const page2 = second.json();
    expect(page2.nextCursor).toBeUndefined();
    const seen = [...page1.items, ...page2.items].map((m: { runId: string }) => m.runId).sort();
    expect(seen).toEqual(["r1", "r2", "r3"]); // all of acme's, exactly once — rival's r9 never appears
  });

  it("is absent (404) when no trajectory store is configured", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    expect((await app.inject({ method: "GET", url: "/trajectories", headers: H })).statusCode).toBe(404);
  });
});
