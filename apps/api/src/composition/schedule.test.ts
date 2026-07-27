import type { ScorecardService } from "@everdict/application-control";
import { InMemoryScheduleStore } from "@everdict/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleServiceRef, wireScheduleService } from "./schedule.js";

// Regression for the live 400: the report-runner adapter must speak the agent's internal vocabulary
// (`workspace`, the /agent/events precedent) while the port input speaks control-plane `tenant` — an input
// spread silently shipped `tenant` and the agent rejected every fire.
describe("wireScheduleService — report-runner adapter wire shape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts the internal-report body with workspace (mapped from tenant) + the schedule/view coordinates", async () => {
    vi.stubEnv("AGENT_SERVICE_URL", "http://agent.test");
    vi.stubEnv("AGENT_INTERNAL_TOKEN", "shhh");
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ sessionId: "sess-1", artifactId: "art-1" }), { status: 200 });
      }),
    );

    const store = new InMemoryScheduleStore();
    const service = wireScheduleService(new ScheduleServiceRef(), {
      scheduleStore: store,
      // The report path never touches the scorecard service — a throwing stub keeps the test honest.
      scorecardService: {
        submit: async () => {
          throw new Error("unused");
        },
        ingestPull: async () => {
          throw new Error("unused");
        },
        get: async () => undefined,
      } as unknown as ScorecardService,
    });
    await service.create({
      tenant: "acme",
      createdBy: "alice",
      name: "weekly",
      cron: "0 9 * * 1",
      runTemplate: { report: { view: "v-1", compare: "previous-period" }, judges: [] },
    });
    const created = (await service.list("acme"))[0];
    if (!created) throw new Error("schedule missing");

    const res = await service.fire("acme", created.id);
    expect(res).toEqual({ artifactId: "art-1" });
    expect(bodies[0]).toEqual({
      workspace: "acme", // NOT `tenant` — the agent's internal schema
      createdBy: "alice",
      scheduleId: created.id,
      scheduleName: "weekly",
      view: "v-1",
      compare: "previous-period",
    });
  });
});
