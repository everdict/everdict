import { PlatformEventService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryPlatformEventStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in event tests");
  },
};
const svc = () => new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });

function harness() {
  const store = new InMemoryPlatformEventStore();
  const platformEvents = new PlatformEventService({ store, newId: () => `ev-${++harness.seq}` });
  const app = buildServer({ service: svc(), platformEvents, internalToken: "itok" });
  return { app, platformEvents };
}
harness.seq = 0;

// The internal reconcile cursor (agent-automation A1): the agent service walks `seq > after` per workspace.
describe("GET /internal/events — platform-event reconcile cursor", () => {
  it("returns a workspace's events ascending from the cursor, kind-filterable", async () => {
    const { app, platformEvents } = harness();
    await platformEvents.emit({
      workspace: "acme",
      kind: "scorecard.submitted",
      subject: { type: "scorecard", id: "sc-1" },
      message: "submitted",
    });
    await platformEvents.emit({
      workspace: "acme",
      kind: "scorecard.completed",
      subject: { type: "scorecard", id: "sc-1" },
      message: "completed",
    });
    await platformEvents.emit({
      workspace: "other",
      kind: "scorecard.completed",
      subject: { type: "scorecard", id: "sc-9" },
      message: "other workspace",
    });

    const all = await app.inject({
      method: "GET",
      url: "/internal/events?workspace=acme",
      headers: { "x-internal-token": "itok" },
    });
    expect(all.statusCode).toBe(200);
    const events = (all.json() as { events: Array<{ kind: string; seq: number }> }).events;
    expect(events.map((e) => e.kind)).toEqual(["scorecard.submitted", "scorecard.completed"]);

    const after = await app.inject({
      method: "GET",
      url: `/internal/events?workspace=acme&after=${events[0]?.seq}&kinds=scorecard.completed`,
      headers: { "x-internal-token": "itok" },
    });
    const later = (after.json() as { events: Array<{ kind: string; seq: number }> }).events;
    expect(later).toHaveLength(1);
    expect(later[0]?.kind).toBe("scorecard.completed");
    await app.close();
  });

  it("rejects a wrong internal token (403) and a missing workspace (400)", async () => {
    const { app } = harness();
    const wrong = await app.inject({
      method: "GET",
      url: "/internal/events?workspace=acme",
      headers: { "x-internal-token": "nope" },
    });
    expect(wrong.statusCode).toBe(403);
    const missing = await app.inject({
      method: "GET",
      url: "/internal/events",
      headers: { "x-internal-token": "itok" },
    });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it("is fail-closed 404 when no internal token is configured", async () => {
    const store = new InMemoryPlatformEventStore();
    const platformEvents = new PlatformEventService({ store });
    const app = buildServer({ service: svc(), platformEvents });
    const res = await app.inject({ method: "GET", url: "/internal/events?workspace=acme" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
