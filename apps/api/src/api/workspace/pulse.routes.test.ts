import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryAgentTaskStore,
  InMemoryApprovalStore,
  InMemoryInitiativeStore,
  InMemoryIssueStore,
  InMemoryPlatformEventStore,
  InMemoryProjectStore,
  InMemoryRunStore,
  InMemoryScorecardStore,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { WorkspacePulseService } from "../../core/workspace/workspace-pulse-service.js";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in pulse tests");
  },
};

const ADMIN = { "x-everdict-tenant": "acme" };

function build(options: { withPulse?: boolean } = {}) {
  const issues = new InMemoryIssueStore();
  const pulse = new WorkspacePulseService({
    issues,
    projects: new InMemoryProjectStore(),
    initiatives: new InMemoryInitiativeStore(),
    tasks: new InMemoryAgentTaskStore(),
    approvals: new InMemoryApprovalStore(),
    scorecards: new InMemoryScorecardStore(),
    events: new InMemoryPlatformEventStore(),
  });
  return buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    ...(options.withPulse === false ? {} : { workspacePulseService: pulse }),
  });
}

describe("GET /workspace/pulse", () => {
  it("answers the whole reading — state and trend — in one call", async () => {
    // Given: a composition with the pulse wired
    const app = build();

    // When: the home screen asks for a week
    const res = await app.inject({ method: "GET", url: "/workspace/pulse?days=7", headers: ADMIN });

    // Then: every band the screen draws is present, and the trend spine has one point per day asked for
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window.days).toBe(7);
    expect(body).toMatchObject({
      work: { open: 0, inProgress: 0, regressed: 0 },
      goals: { initiatives: 0, projects: 0, atRisk: 0 },
      agents: { runs: 0, openTasks: 0, awaitingApproval: 0 },
      evaluation: { scorecards: 0, runs: 0, failed: 0 },
    });
    expect(body.trend.activity).toHaveLength(7);
    expect(body.trend.flow).toHaveLength(7);
    expect(body.trend.quality).toHaveLength(7);
  });

  it("defaults the window rather than making the caller name one", async () => {
    const res = await build().inject({ method: "GET", url: "/workspace/pulse", headers: ADMIN });
    expect(res.json().window.days).toBe(30);
  });

  it("refuses a window it cannot serve instead of silently clamping it", async () => {
    const res = await build().inject({ method: "GET", url: "/workspace/pulse?days=365", headers: ADMIN });
    expect(res.statusCode).toBe(400);
  });

  it("is absent, not broken, when the deployment composes no pulse", async () => {
    const res = await build({ withPulse: false }).inject({ method: "GET", url: "/workspace/pulse", headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});
