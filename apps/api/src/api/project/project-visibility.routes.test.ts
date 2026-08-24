import { InitiativeService, ProjectService, RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryInitiativeStore,
  InMemoryIssueStore,
  InMemoryProjectStore,
  InMemoryRunStore,
  InMemoryTeamStore,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// A project is a WORKSPACE record that names the teams working on it, so it is the workspace's to read — the one
// narrowing is a team choosing to be private, and a project is visible when ANY of its teams is. A goal one level
// up counts every project underneath (progress is one number for everybody) but only NAMES the ones the reader
// may see.
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused");
  },
};

async function build() {
  const teamStore = new InMemoryTeamStore();
  const issues = new InMemoryIssueStore();
  const teamService = new TeamService({ store: teamStore, issues });
  const projects = new InMemoryProjectStore();
  const initiatives = new InMemoryInitiativeStore();
  const web = await teamService.create({ tenant: "acme", key: "WEB", name: "Web", createdBy: "system" });
  const secret = await teamService.create({
    tenant: "acme",
    key: "SEC",
    name: "Secret",
    createdBy: "system",
    isPrivate: true,
  });
  await teamService.addMember("acme", secret.id, "insider", { subject: "system" });
  const projectService = new ProjectService({ store: projects, issues, teams: teamStore, initiatives });
  const initiativeService = new InitiativeService({ store: initiatives, projects, issues });
  return { teamService, projectService, initiativeService, web, secret };
}

type Ctx = Awaited<ReturnType<typeof build>>;

function serverFor(ctx: Ctx, subject: string, teams: string[], roles = ["member"]) {
  return buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    teamService: ctx.teamService,
    projectService: ctx.projectService,
    initiativeService: ctx.initiativeService,
    requireAuth: true,
    authenticator: {
      async authenticate() {
        return { subject, workspace: "acme", roles, via: "oidc" as const, teams };
      },
    },
  });
}

const bearer = { authorization: "Bearer t" };

describe("project visibility — a workspace record, narrowed only by team privacy", () => {
  it("shows another PUBLIC team's project to the whole workspace", async () => {
    const ctx = await build();
    await ctx.projectService.create({ tenant: "acme", name: "Ship it", createdBy: "u", teamIds: [ctx.web.id] });
    const outsider = serverFor(ctx, "other", []);
    const list = await outsider.inject({ method: "GET", url: "/projects", headers: bearer });
    expect(list.json().map((p: { name: string }) => p.name)).toEqual(["Ship it"]);
    await outsider.close();
  });

  it("hides a PRIVATE team's project, and answers its detail 404 rather than 403", async () => {
    const ctx = await build();
    const hidden = await ctx.projectService.create({
      tenant: "acme",
      name: "Classified",
      createdBy: "insider",
      teamIds: [ctx.secret.id],
    });

    const insider = serverFor(ctx, "insider", [ctx.secret.id]);
    expect((await insider.inject({ method: "GET", url: "/projects", headers: bearer })).json()).toHaveLength(1);
    await insider.close();

    const outsider = serverFor(ctx, "other", [ctx.web.id]);
    expect((await outsider.inject({ method: "GET", url: "/projects", headers: bearer })).json()).toEqual([]);
    expect((await outsider.inject({ method: "GET", url: `/projects/${hidden.id}`, headers: bearer })).statusCode).toBe(
      404,
    );
    await outsider.close();
  });

  it("keeps a project whose teams OVERLAP — being on one of the teams doing the work is enough", async () => {
    const ctx = await build();
    await ctx.projectService.create({
      tenant: "acme",
      name: "Joint",
      createdBy: "insider",
      teamIds: [ctx.secret.id, ctx.web.id],
    });
    const outsider = serverFor(ctx, "other", [ctx.web.id]);
    expect((await outsider.inject({ method: "GET", url: "/projects", headers: bearer })).json()).toHaveLength(1);
    await outsider.close();
  });
});
