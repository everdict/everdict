import {
  CycleService,
  IssueService,
  RunService,
  TeamService,
  WorkflowStateService,
} from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryCycleStore,
  InMemoryIssueStore,
  InMemoryRunStore,
  InMemoryTeamStore,
  InMemoryWorkflowStateStore,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// A cycle IS a team's ("Cycle 3" is that team's third) and so is its board, so both follow the team's own
// visibility. They used to follow nothing at all: a private team's iterations and workflow columns were the
// workspace's to read, while its issues were not.
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused");
  },
};

async function build() {
  const teamStore = new InMemoryTeamStore();
  const issues = new InMemoryIssueStore();
  const teamService = new TeamService({ store: teamStore, issues });
  const open = await teamService.create({ tenant: "acme", key: "WEB", name: "Web", createdBy: "system" });
  const secret = await teamService.create({
    tenant: "acme",
    key: "SEC",
    name: "Secret",
    createdBy: "system",
    isPrivate: true,
  });
  await teamService.addMember("acme", secret.id, "insider", { subject: "system" });
  const cycleService = new CycleService({ store: new InMemoryCycleStore(), teams: teamStore, issues });
  const workflowStateService = new WorkflowStateService({ store: new InMemoryWorkflowStateStore(), issues });
  return { teamService, cycleService, workflowStateService, open, secret };
}

type Ctx = Awaited<ReturnType<typeof build>>;

function serverFor(ctx: Ctx, subject: string, teams: string[]) {
  return buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    teamService: ctx.teamService,
    cycleService: ctx.cycleService,
    workflowStateService: ctx.workflowStateService,
    requireAuth: true,
    authenticator: {
      async authenticate() {
        return { subject, workspace: "acme", roles: ["member"], via: "oidc" as const, teams };
      },
    },
  });
}

const bearer = { authorization: "Bearer t" };

describe("a cycle and a board follow their team's visibility", () => {
  it("lists a PUBLIC team's cycles to the workspace and hides a PRIVATE team's", async () => {
    const ctx = await build();
    await ctx.cycleService.create({ tenant: "acme", teamId: ctx.open.id, createdBy: "u" });
    const hidden = await ctx.cycleService.create({ tenant: "acme", teamId: ctx.secret.id, createdBy: "insider" });

    const outsider = serverFor(ctx, "other", [ctx.open.id]);
    const list = await outsider.inject({ method: "GET", url: "/cycles", headers: bearer });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].teamId).toBe(ctx.open.id);
    // Asking for it by id is answered like one that does not exist.
    expect((await outsider.inject({ method: "GET", url: `/cycles/${hidden.id}`, headers: bearer })).statusCode) //
      .toBe(404);
    await outsider.close();

    const insider = serverFor(ctx, "insider", [ctx.secret.id]);
    expect((await insider.inject({ method: "GET", url: "/cycles", headers: bearer })).json()).toHaveLength(2);
    expect((await insider.inject({ method: "GET", url: `/cycles/${hidden.id}`, headers: bearer })).statusCode) //
      .toBe(200);
    await insider.close();
  });

  it("refuses a PRIVATE team's board to outsiders — the columns are the team's own", async () => {
    const ctx = await build();
    const outsider = serverFor(ctx, "other", [ctx.open.id]);
    expect((await outsider.inject({ method: "GET", url: "/teams/SEC/states", headers: bearer })).statusCode).toBe(404);
    expect((await outsider.inject({ method: "GET", url: "/teams/WEB/states", headers: bearer })).statusCode).toBe(200);
    await outsider.close();
  });
});
