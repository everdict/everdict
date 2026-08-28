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

// ── [R119 COUNTEREXAMPLE] AND THE OPERATIONAL DOORS, WHICH THE READ CEILING NEVER COVERED ───────────
//
// The cases above pin how a batch is BORN into a team and how reading it is ceilinged. Nothing pinned
// WRITING one, and docs/auth.md §"The team axis" names results explicitly: "every result (scorecard · run)
// records a `teamId`", and "WRITING another team's asset is refused".
//
// Every operational door gated a bare `scorecards:run`:
//
//     POST /scorecards/:id/cancel · /retry · /rerun · /rescore-unmeasured · /gate/override
//
// so a member of another team — one who is answered 404 for the same id on GET — could stop a running
// batch, re-drive it, or override its gate decision. Reading was narrower than writing, which is the
// wrong way round and the exact inversion the axis exists to prevent.
//
// `DELETE /scorecards/:id` is NOT here: its creator-or-admin rule is enforced in the service, which the
// route's own comment says, and that rule is stricter than the team one.
//
// Seen RED before the fix: "an outsider cancelled a private team's batch: expected 200 to be 404".
describe("[R119 COUNTEREXAMPLE] another team's batch cannot be operated on", () => {
  async function privateBatch() {
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
    await insider.close();
    return { ctx, id: created.id as string };
  }

  // Every operational door, driven by an outsider. 404 rather than 403, because the read answer for this id
  // is already 404 and a refusal that leaks existence is the thing team privacy is for.
  for (const door of ["cancel", "retry", "rerun", "rescore-unmeasured"]) {
    it(`refuses POST /scorecards/:id/${door} from a team the batch does not belong to`, async () => {
      const { ctx, id } = await privateBatch();
      const outsider = serverFor(ctx, [ctx.mobile.id], "other");

      const res = await outsider.inject({ method: "POST", url: `/scorecards/${id}/${door}`, headers: bearer });

      expect(res.statusCode, `an outsider reached /${door} on a private team's batch`).toBe(404);
      await outsider.close();
    });
  }

  it("refuses the gate override — the door that changes what a batch DECIDED", async () => {
    const { ctx, id } = await privateBatch();
    const outsider = serverFor(ctx, [ctx.mobile.id], "other");

    const res = await outsider.inject({
      method: "POST",
      url: `/scorecards/${id}/gate/override`,
      headers: bearer,
      payload: { decisionId: "dec-1", reason: "because I said so" }, // a VALID body: the refusal must be the gate's
    });

    expect(res.statusCode, "an outsider overrode a private team's gate decision").toBe(404);
    await outsider.close();
  });

  it("ALLOWS the owning team — the control that keeps the gate from being a wall", async () => {
    const { ctx, id } = await privateBatch();
    const insider = serverFor(ctx, [
      ctx.web.id,
      (await ctx.teamService.list("acme")).find((t) => t.key === "SEC")?.id ?? "",
    ]);

    const res = await insider.inject({ method: "POST", url: `/scorecards/${id}/cancel`, headers: bearer });

    expect(res.statusCode, "the batch's own team was refused its cancel").not.toBe(404);
    await insider.close();
  });
});

// ── …AND THE MCP TWINS, BECAUSE PARITY IS STRUCTURAL (arch-review 119) ─────────────────────────────
//
// A gate one transport carries and the other does not is the whole shape this wave keeps finding. The tools
// take the same actions on the same records, so they answer the same NOT_FOUND.
describe("[R119 COUNTEREXAMPLE] the MCP operational tools refuse another team's batch", () => {
  it("cancel_scorecard, rerun_scorecard and retry_scorecard are all NOT_FOUND to an outsider", async () => {
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
    await insider.close();

    const { buildMcpServer } = await import("../../mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const outsider = {
      subject: "other",
      workspace: "acme",
      roles: ["member"],
      via: "oidc" as const,
      teams: [ctx.mobile.id],
    };
    const server = buildMcpServer(
      { scorecardService: ctx.scorecardService, teamService: ctx.teamService } as unknown as Parameters<
        typeof buildMcpServer
      >[0],
      outsider as unknown as Parameters<typeof buildMcpServer>[1],
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(serverT);
    await client.connect(clientT);

    for (const tool of ["cancel_scorecard", "rerun_scorecard", "retry_scorecard"]) {
      const res = await client.callTool({ name: tool, arguments: { id: created.id } });
      const text = ((res as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
      expect(text, `an agent reached ${tool} on a private team's batch`).toContain("NOT_FOUND");
    }
  });
});
