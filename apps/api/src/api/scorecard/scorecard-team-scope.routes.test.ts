import { RunService, ScorecardService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryScorecardStore, InMemoryTeamStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The team axis on a BATCH, over HTTP. Ownership on a scorecard was wired end to end but never actually landed:
// the route resolved an owner, the domain factory dropped the field, and the Postgres store had neither the
// column in its INSERT nor the filter in its WHERE — so every team page showed either the whole workspace or
// nothing at all. These lock the three joints, plus the read isolation the ownership exists for.

const dispatcher: Dispatcher = {
  async dispatch(job) {
    return {
      caseId: job.evalCase.id,
      harness: `${job.harness.id}@${job.harness.version}`,
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [{ graderId: "steps", metric: "steps", value: 1, pass: true }],
    };
  },
};

async function build() {
  const teamStore = new InMemoryTeamStore();
  const teamService = new TeamService({ store: teamStore, issues: new InMemoryIssueStore() });
  const web = await teamService.create({ tenant: "acme", key: "WEB", name: "Web", createdBy: "system" });
  const mobile = await teamService.create({ tenant: "acme", key: "MOB", name: "Mobile", createdBy: "system" });

  const datasets = new InMemoryDatasetRegistry();
  await datasets.register("acme", {
    id: "smoke",
    version: "1.0.0",
    tags: [],
    cases: [{ id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
  });
  const templates = new InMemoryHarnessTemplateRegistry();
  await templates.register("acme", {
    kind: "service",
    category: "topology",
    id: "topo",
    version: "1",
    services: [{ name: "planner", needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies: [],
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  });
  const harnesses = new InMemoryHarnessInstanceRegistry(templates);
  // The harness belongs to Web — which is what a batch run against it inherits.
  await harnesses.register(
    "acme",
    { id: "web-agent", version: "1.0.0", template: { id: "topo", version: "1" }, pins: { planner: "p:1" } },
    "u",
    web.id,
  );

  const store = new InMemoryScorecardStore();
  const scorecardService = new ScorecardService({ dispatcher, store, datasets, harnesses });
  return { teamService, store, scorecardService, web, mobile };
}

type Ctx = Awaited<ReturnType<typeof build>>;

// A server whose principal is a fixed member of `teams` (the dev-header fallback is admin, and admin
// deliberately sees every team).
function serverFor(ctx: Ctx, teams: string[], subject = "u") {
  return buildServer({
    service: new RunService({ dispatcher, store: new InMemoryRunStore() }),
    scorecardService: ctx.scorecardService,
    teamService: ctx.teamService,
    requireAuth: true,
    authenticator: {
      async authenticate() {
        return { subject, workspace: "acme", roles: ["member"], via: "oidc" as const, teams };
      },
    },
  });
}

const bearer = { authorization: "Bearer t" };
const body = { dataset: { id: "smoke", version: "1.0.0" }, harness: { id: "web-agent", version: "1.0.0" } };

describe("a scorecard belongs to a team", () => {
  it("stamps the owning team on the record — a submitted batch is never born ownerless", async () => {
    const ctx = await build();
    const app = serverFor(ctx, [ctx.web.id]);
    const res = await app.inject({ method: "POST", url: "/scorecards", headers: bearer, payload: body });
    expect(res.statusCode).toBe(202);
    expect(res.json().teamId).toBe(ctx.web.id);
    await app.close();
  });

  it("inherits the HARNESS's team when none is named — which is the only answer a schedule or a CI token has", async () => {
    const ctx = await build();
    // The submitter is on Mobile AND Web, in that order: "the caller's first team" would have said Mobile, and
    // the batch would have landed in a team that has nothing to do with what actually ran.
    const app = serverFor(ctx, [ctx.mobile.id, ctx.web.id]);
    const res = await app.inject({ method: "POST", url: "/scorecards", headers: bearer, payload: body });
    expect(res.json().teamId).toBe(ctx.web.id);
    await app.close();
  });

  it("refuses to file a batch under a team the caller is not on", async () => {
    const ctx = await build();
    const app = serverFor(ctx, [ctx.web.id]);
    const res = await app.inject({
      method: "POST",
      url: "/scorecards",
      headers: bearer,
      payload: { ...body, teamId: ctx.mobile.id },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("stays readable across teams — a workspace's evaluations are the workspace's to learn from", async () => {
    const ctx = await build();
    const owner = serverFor(ctx, [ctx.web.id]);
    const created = (await owner.inject({ method: "POST", url: "/scorecards", headers: bearer, payload: body })).json();
    await owner.close();

    const other = serverFor(ctx, [ctx.mobile.id], "other");
    expect((await other.inject({ method: "GET", url: "/scorecards", headers: bearer })).json()).toHaveLength(1);
    expect((await other.inject({ method: "GET", url: `/scorecards/${created.id}`, headers: bearer })).statusCode) //
      .toBe(200);
    await other.close();
  });

  it("hides a PRIVATE team's batch — the one narrowing, answered 404 so it is not discoverable", async () => {
    const ctx = await build();
    const secret = await ctx.teamService.create({
      tenant: "acme",
      key: "SEC",
      name: "Secret",
      createdBy: "system",
      isPrivate: true,
    });
    await ctx.teamService.addMember("acme", secret.id, "u", { subject: "system" });
    const insider = serverFor(ctx, [secret.id, ctx.web.id]);
    const created = (
      await insider.inject({
        method: "POST",
        url: "/scorecards",
        headers: bearer,
        payload: { ...body, teamId: secret.id },
      })
    ).json();
    expect((await insider.inject({ method: "GET", url: "/scorecards", headers: bearer })).json()).toHaveLength(1);
    await insider.close();

    const outsider = serverFor(ctx, [ctx.mobile.id], "other");
    expect((await outsider.inject({ method: "GET", url: "/scorecards", headers: bearer })).json()).toEqual([]);
    expect((await outsider.inject({ method: "GET", url: `/scorecards/${created.id}`, headers: bearer })).statusCode) //
      .toBe(404);
    await outsider.close();
  });

  it("narrows to one team with ?team= by KEY, and never past the caller's own ceiling", async () => {
    const ctx = await build();
    const app = serverFor(ctx, [ctx.web.id]);
    await app.inject({ method: "POST", url: "/scorecards", headers: bearer, payload: body });
    expect((await app.inject({ method: "GET", url: "/scorecards?team=WEB", headers: bearer })).json()).toHaveLength(1);
    // Another team's page is a different question, not a refused one — it lists that team's batches, of which
    // there are none here.
    expect((await app.inject({ method: "GET", url: "/scorecards?team=MOB", headers: bearer })).json()).toEqual([]);
    await app.close();
  });
});
