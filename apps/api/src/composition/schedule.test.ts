import type { ScorecardService } from "@everdict/application-control";
import { storedExecutionId } from "@everdict/contracts";
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
    const created = (await service.list(storedExecutionId("acme")))[0];
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

describe("wireScheduleService — the reserved 'everdict' source windows the OWNED store (N2 continuous evaluation)", () => {
  it("a pull-mode fire lists the window's sealed runIds newest-first and hands them to ingestPull", async () => {
    const seen: Array<{ source: unknown; runs: Array<{ caseId: string; runId: string }> }> = [];
    // Fixture times ride the REAL clock (the composition's window is now − windowHours): three sealed
    // trajectories, newest first like the real store — only the two inside the 24h window belong to the fire.
    const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    const trajectoryStore = {
      async seal(): Promise<never> {
        throw new Error("unused");
      },
      async planes() {
        return undefined;
      },
      async events() {
        return { kind: "absent" as const };
      },
      // The cost read the ledger answers without touching a body (`d60e5285`). This double holds no
      // trajectory, so `absent` is its only honest answer — never `derived` with zeros, which is the
      // collapse that union exists to prevent.
      async usage() {
        return { kind: "absent" as const };
      },
      async ingestedSince() {
        return { trajectories: 0, events: 0 };
      },
      async deleteOlderThan() {
        return 0;
      },
      // No offload in this fixture, so there is nothing to enumerate — the honest answer, not a stub.
      async payloadRefsOlderThan() {
        return [];
      },
      async list() {
        return {
          items: [
            { runId: "r-new", tenant: "acme", source: "otlp" as const, eventCount: 1, sealedAt: iso(1) },
            { runId: "r-mid", tenant: "acme", source: "otlp" as const, eventCount: 1, sealedAt: iso(20) },
            { runId: "r-old", tenant: "acme", source: "otlp" as const, eventCount: 1, sealedAt: iso(40) },
          ],
        };
      },
    };
    const service = wireScheduleService(new ScheduleServiceRef(), {
      scheduleStore: new InMemoryScheduleStore(),
      scorecardService: {
        submit: async () => {
          throw new Error("unused");
        },
        ingestPull: async (input: { source: unknown; runs: Array<{ caseId: string; runId: string }> }) => {
          seen.push({ source: input.source, runs: input.runs });
          return { id: "sc-cont", status: "queued" };
        },
        get: async () => undefined,
      } as unknown as ScorecardService,
      trajectoryStore,
    });

    await service.create({
      tenant: "acme",
      createdBy: "alice",
      name: "continuous",
      cron: "0 * * * *",
      runTemplate: { pull: { source: "everdict", windowHours: 24 }, judges: [] },
    });
    const created = (await service.list(storedExecutionId("acme")))[0];
    if (!created) throw new Error("schedule missing");
    await service.fire("acme", created.id);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.runs.map((r) => r.runId)).toEqual(["r-new", "r-mid"]); // the window's ids, newest first
    expect(seen[0]?.source).toMatchObject({ name: "everdict" }); // ingestPull's own-store branch takes it from here
  });
});
