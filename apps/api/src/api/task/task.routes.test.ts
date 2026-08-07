import { RunService, TaskService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryAgentTaskStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in task tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

function build() {
  const store = new InMemoryAgentTaskStore();
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    taskService: new TaskService({ store }),
  });
  return { app, store };
}

describe("task ledger routes", () => {
  it("creates, lists (with status filter), reads, and patches a task through its lifecycle", async () => {
    const { app } = build();
    // Given a created task
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: H,
      payload: { subject: "Run the baseline on web@2.2.0", blockedBy: [] },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.status).toBe("pending");
    // When it is claimed, Then the claimer becomes the owner
    const claimed = await app.inject({
      method: "PATCH",
      url: `/tasks/${task.id}`,
      headers: H,
      payload: { status: "in_progress" },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().owner).toBeDefined();
    // And the status filter sees it under in_progress only
    expect((await app.inject({ method: "GET", url: "/tasks?status=in_progress", headers: H })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/tasks?status=pending", headers: H })).json()).toHaveLength(0);
    // And the single read returns it
    expect((await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: H })).statusCode).toBe(200);
    await app.close();
  });

  it("completion carries output back to the waiting requester, and a rival claim maps to 409", async () => {
    const { app } = build();
    const task = (
      await app.inject({ method: "POST", url: "/tasks", headers: H, payload: { subject: "run the baseline" } })
    ).json();
    // The assignee claims and completes WITH results
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/tasks/${task.id}`,
          headers: H,
          payload: { status: "in_progress" },
        })
      ).statusCode,
    ).toBe(200);
    const done = await app.inject({
      method: "PATCH",
      url: `/tasks/${task.id}`,
      headers: H,
      payload: { status: "completed", output: "Pass rate 84% — two auth regressions." },
    });
    expect(done.statusCode).toBe(200);
    // The requester woken by task.completed reads the report off the record
    expect((await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: H })).json().output).toContain("84%");
    // A rival claiming a task someone else holds gets 409 with the owner named
    const rival = (
      await app.inject({ method: "POST", url: "/tasks", headers: H, payload: { subject: "contended" } })
    ).json();
    await app.inject({
      method: "PATCH",
      url: `/tasks/${rival.id}`,
      headers: { "x-everdict-tenant": "acme" },
      payload: { status: "in_progress", owner: "worker-a" },
    });
    const lost = await app.inject({
      method: "PATCH",
      url: `/tasks/${rival.id}`,
      headers: H,
      payload: { status: "in_progress" },
    });
    expect(lost.statusCode).toBe(409);
    expect(lost.json().message).toContain("worker-a");
    await app.close();
  });

  it("validates the body (400), scopes unknown ids to 404, and 404s without a composed service", async () => {
    const { app } = build();
    expect((await app.inject({ method: "POST", url: "/tasks", headers: H, payload: { subject: "" } })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: "GET", url: "/tasks/missing", headers: H })).statusCode).toBe(404);
    await app.close();
    // Feature gate: a server composed WITHOUT the service answers 404, not 500
    const bare = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    expect((await bare.inject({ method: "GET", url: "/tasks", headers: H })).statusCode).toBe(404);
    await bare.close();
  });

  it("requires auth when the dev fallback is off (401), and a viewer role cannot write (403)", async () => {
    // requireAuth: no credential → 401 (the dev tenant-header fallback is disabled)
    const strict = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      taskService: new TaskService({ store: new InMemoryAgentTaskStore() }),
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "u", workspace: "acme", roles: ["viewer"], via: "oidc" as const };
        },
      },
    });
    expect((await strict.inject({ method: "GET", url: "/tasks" })).statusCode).toBe(401);
    // A viewer may read the ledger but not write to it
    const bearer = { authorization: "Bearer any" };
    expect((await strict.inject({ method: "GET", url: "/tasks", headers: bearer })).statusCode).toBe(200);
    expect(
      (await strict.inject({ method: "POST", url: "/tasks", headers: bearer, payload: { subject: "t" } })).statusCode,
    ).toBe(403);
    await strict.close();
  });
});
