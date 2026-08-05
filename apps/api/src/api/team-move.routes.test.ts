import { RunService } from "@everdict/application-control";
import type { Authenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { DatasetSchema, NotFoundError } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import { InMemoryDatasetRegistry, InMemoryJudgeRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";

// Handing a capability to another team — the transport half. Ownership used to be settled at registration and
// frozen forever, so these cover the act that unfroze it AND the two refusals that make it safe: you cannot move
// something out of a team you are not on, and you cannot push it onto one you are not on either.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in these tests");
  },
};

// A member of exactly the named teams — the axis is about the roster, so the tests have to carry one.
const memberOf = (teams: string[]): Authenticator => ({
  async authenticate() {
    return { subject: "alice", workspace: "acme", roles: ["member"], via: "oidc", teams };
  },
});

const ENG = "team_eng";
const PLATFORM = "team_platform";
const H = { authorization: "Bearer x" };

// The team service the routes resolve refs through. `resolveId` is the whole surface a ref needs; a deployment
// with no team service keeps refs verbatim, which is the team-less shape.
const teams = {
  async resolveId(_tenant: string, ref: string) {
    // The real TeamService answers an unknown ref with NotFoundError, and the routes rely on that shape.
    if (![ENG, PLATFORM].includes(ref)) throw new NotFoundError("NOT_FOUND", { team: ref }, "Team not found.");
    return ref;
  },
  async visibleTeamIds() {
    return undefined;
  },
  async canSeeTeam() {
    return true;
  },
};

function build(callerTeams: string[]) {
  const datasetRegistry = new InMemoryDatasetRegistry();
  const judgeRegistry = new InMemoryJudgeRegistry();
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    datasetRegistry,
    judgeRegistry,
    // biome-ignore lint/suspicious/noExplicitAny: the routes need only resolveId/visibleTeamIds/canSeeTeam here
    teamService: teams as any,
    requireAuth: true,
    authenticator: memberOf(callerTeams),
  });
  return { app, datasetRegistry };
}

// Parsed through the schema so the registry gets the same shape a route would hand it (defaults applied).
const dataset = (version: string, id = "swe-mini") =>
  DatasetSchema.parse({ id, version, cases: [{ id: "c1", env: { kind: "prompt" }, task: "hi", graders: [] }] });

async function seed(registry: InMemoryDatasetRegistry, versions: string[], teamId = ENG) {
  for (const version of versions) await registry.register("acme", dataset(version), "alice", teamId);
}

describe("POST /datasets/:id/team — ownership transfer", () => {
  it("moves every version at once and answers with both teams", async () => {
    const { app, datasetRegistry } = build([ENG, PLATFORM]);
    await seed(datasetRegistry, ["1.0.0", "1.1.0"]);

    const res = await app.inject({
      method: "POST",
      url: "/datasets/swe-mini/team",
      headers: H,
      payload: { teamId: PLATFORM },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspace: "acme",
      id: "swe-mini",
      teamId: PLATFORM,
      previousTeamId: ENG,
    });
    expect(await datasetRegistry.teamOfVersion("acme", "swe-mini", "1.0.0")).toBe(PLATFORM);
    expect(await datasetRegistry.teamOfVersion("acme", "swe-mini", "1.1.0")).toBe(PLATFORM);
  });

  it("403 when the caller is not on the team it is LEAVING", async () => {
    const { app, datasetRegistry } = build([PLATFORM]);
    await seed(datasetRegistry, ["1.0.0"]);

    const res = await app.inject({
      method: "POST",
      url: "/datasets/swe-mini/team",
      headers: H,
      payload: { teamId: PLATFORM },
    });

    expect(res.statusCode).toBe(403);
    expect(await datasetRegistry.teamOfVersion("acme", "swe-mini", "1.0.0")).toBe(ENG); // nothing moved
  });

  it("403 when the caller is not on the team it is JOINING", async () => {
    const { app, datasetRegistry } = build([ENG]);
    await seed(datasetRegistry, ["1.0.0"]);

    const res = await app.inject({
      method: "POST",
      url: "/datasets/swe-mini/team",
      headers: H,
      payload: { teamId: PLATFORM },
    });

    expect(res.statusCode).toBe(403);
    expect(await datasetRegistry.teamOfVersion("acme", "swe-mini", "1.0.0")).toBe(ENG);
  });

  it("404 for a dataset this workspace does not own, and 409 for a move that changes nothing", async () => {
    const { app, datasetRegistry } = build([ENG, PLATFORM]);
    await seed(datasetRegistry, ["1.0.0"]);

    const missing = await app.inject({
      method: "POST",
      url: "/datasets/nope/team",
      headers: H,
      payload: { teamId: PLATFORM },
    });
    expect(missing.statusCode).toBe(404);

    const noop = await app.inject({
      method: "POST",
      url: "/datasets/swe-mini/team",
      headers: H,
      payload: { teamId: ENG },
    });
    expect(noop.statusCode).toBe(409);
  });

  it("400 on a missing teamId, 404 on a team that does not exist", async () => {
    const { app, datasetRegistry } = build([ENG, PLATFORM]);
    await seed(datasetRegistry, ["1.0.0"]);

    const empty = await app.inject({ method: "POST", url: "/datasets/swe-mini/team", headers: H, payload: {} });
    expect(empty.statusCode).toBe(400);

    // An unknown team is 404 rather than a puzzling 403 — the ref is resolved before any gate sees it.
    const unknown = await app.inject({
      method: "POST",
      url: "/datasets/swe-mini/team",
      headers: H,
      payload: { teamId: "team_ghost" },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("POST /judges/:id/team — the same act, the same answers", () => {
  it("moves a judge and refuses a destination the caller is not on", async () => {
    const { app } = build([ENG, PLATFORM]);

    const register = await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: {
        kind: "code",
        id: "truncation",
        version: "1.0.0",
        language: "python",
        code: "print('[]')",
        teamId: ENG,
      },
    });
    expect(register.statusCode).toBe(201);

    const moved = await app.inject({
      method: "POST",
      url: "/judges/truncation/team",
      headers: H,
      payload: { teamId: PLATFORM },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: "truncation", teamId: PLATFORM, previousTeamId: ENG });
  });
});
