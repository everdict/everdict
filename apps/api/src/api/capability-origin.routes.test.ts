import { IssueService, withOriginBacklink } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Authenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import type { HarnessTemplateSpec } from "@everdict/contracts";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";

// Registering a capability records WHERE IT CAME FROM, and a capability born from an issue links itself back.
// These are transport tests over the composition main.ts actually builds (the registry wrapped in the backlink
// decorator), because the two halves only mean something together: the stamp is what the detail view reads, and
// the link is what lets the issue notice its own regression later.

const teamAllocator = (() => {
  let n = 0;
  return {
    async allocateForIssue() {
      n += 1;
      return { team: { id: "team-eng" }, grant: { number: n, identifier: `ENG-${n}` } };
    },
  };
})();

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in these tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

const CODE_JUDGE = {
  kind: "code",
  id: "truncation",
  version: "1.0.0",
  language: "python",
  code: "print('[]')",
};

function build() {
  const issueStore = new InMemoryIssueStore();
  const issueService = new IssueService({
    teams: teamAllocator,
    store: issueStore,
    scorecards: new InMemoryScorecardStore(),
  });
  // Exactly how main.ts composes it — one decorator at the composition root, so every caller goes through it.
  const judgeRegistry = withOriginBacklink(new InMemoryJudgeRegistry(), "judge", issueService);
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    issueService,
    judgeRegistry,
  });
  return { app, issueService };
}

async function createIssue(app: ReturnType<typeof build>["app"]) {
  const res = await app.inject({
    method: "POST",
    url: "/issues",
    headers: H,
    payload: { title: "Judge misses truncated answers" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; identifier: string };
}

async function judgeOrigin(app: ReturnType<typeof build>["app"], id: string, version: string) {
  const list = await app.inject({ method: "GET", url: "/judges", headers: H });
  expect(list.statusCode).toBe(200);
  const entry = (list.json() as Array<{ id: string; versionOrigins?: Record<string, unknown> }>).find(
    (j) => j.id === id,
  );
  return entry?.versionOrigins?.[version];
}

describe("re-pin origin — the durable re-pin records the channel and the merge base", () => {
  // The re-pin is the one registration whose `from` the CALLER may not declare: only the service knows the
  // merge base at the moment it registers the successor (docs/architecture/evolution-lineage.md, Track A).
  // The route's contribution is the CHANNEL — `ci` for the keyless CI role, `web` otherwise.
  const template: HarnessTemplateSpec = {
    kind: "service",
    category: "topology",
    id: "bu",
    version: "1",
    services: [{ name: "planner", needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies: [],
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  };
  const D = (c: string): string => `img@sha256:${c.repeat(64)}`;

  async function buildWithHarness(authenticator?: Authenticator) {
    const harnessTemplates = new InMemoryHarnessTemplateRegistry();
    const harnessInstances = new InMemoryHarnessInstanceRegistry(harnessTemplates);
    await harnessTemplates.register("acme", template);
    await harnessInstances.register(
      "acme",
      { template: { id: "bu", version: "1" }, id: "bu", version: "1.0.0", pins: { planner: D("a") } },
      "alice",
    );
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      harnessTemplates,
      harnessInstances,
      ...(authenticator !== undefined ? { authenticator, requireAuth: true } : {}),
    });
    return { app, harnessInstances };
  }

  async function originOf(harnessInstances: InMemoryHarnessInstanceRegistry, version: string) {
    const entry = (await harnessInstances.list("acme")).find((e) => e.id === "bu");
    return entry?.versionOrigins?.[version];
  }

  it("a member's re-pin stamps via 'web' and the merge base, service-owned", async () => {
    const { app, harnessInstances } = await buildWithHarness();
    const res = await app.inject({
      method: "POST",
      url: "/harnesses/bu/pins",
      headers: H,
      payload: { pins: { planner: D("b") } },
    });
    expect(res.statusCode).toBe(201);
    const { version } = res.json() as { version: string };
    expect(await originOf(harnessInstances, version)).toEqual({
      via: "web",
      from: { type: "harness", id: "bu", version: "1.0.0" },
      note: "re-pin: planner",
    });
    await app.close();
  });

  it("the CI role's headless re-pin stamps via 'ci'", async () => {
    const ciAuth: Authenticator = {
      async authenticate() {
        return { subject: "github-actions", workspace: "acme", roles: ["ci"], via: "oidc" };
      },
    };
    const { app, harnessInstances } = await buildWithHarness(ciAuth);
    const res = await app.inject({
      method: "POST",
      url: "/harnesses/bu/pins",
      headers: { authorization: "Bearer t" },
      payload: { pins: { planner: D("c") } },
    });
    expect(res.statusCode).toBe(201);
    const { version } = res.json() as { version: string };
    expect(await originOf(harnessInstances, version)).toMatchObject({
      via: "ci",
      from: { type: "harness", id: "bu", version: "1.0.0" },
    });
    await app.close();
  });
});

describe("capability origin — a registration records where it came from", () => {
  it("stamps the declared issue and resolves it to the STABLE record id, with a display snapshot", async () => {
    // Given: an issue someone is working from
    const { app } = build();
    const issue = await createIssue(app);

    // When: a judge is registered declaring that issue by its IDENTIFIER (what a member pastes at an agent)
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.identifier }, note: "built for ENG-1" } },
    });
    expect(res.statusCode).toBe(201);

    // Then: what is stored is the record id — an identifier is re-minted when an issue moves team, and a stamp
    // that dies on a team move is worse than none. The label is the snapshot the detail view draws.
    expect(await judgeOrigin(app, "truncation", "1.0.0")).toEqual({
      via: "web",
      from: {
        type: "issue",
        id: issue.id,
        label: `${issue.identifier} Judge misses truncated answers`,
      },
      note: "built for ENG-1",
    });
  });

  it("links the judge back to the issue, so a regression against it can surface", async () => {
    const { app } = build();
    const issue = await createIssue(app);

    await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.id } } },
    });

    const detail = await app.inject({ method: "GET", url: `/issues/${issue.id}`, headers: H });
    expect(detail.statusCode).toBe(200);
    const links = (detail.json() as { links: Array<{ type: string; id: string; version?: string }> }).links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ type: "judge", id: "truncation" });
    // At id level, with NO version pinned — the issue means "this judge", not "this judge at 1.0.0", and the
    // regression watch matches at id level for the same reason.
    expect(links[0]).not.toHaveProperty("version");
  });

  it("records the agent and conversation that acted, from the attribution headers", async () => {
    // The bearer says which MEMBER; these headers say which agent ran on their behalf — the same provenance the
    // workspace filesystem already records on a revision.
    const { app } = build();
    const issue = await createIssue(app);

    await app.inject({
      method: "POST",
      url: "/judges",
      headers: {
        ...H,
        "x-everdict-agent-id": "everdict",
        "x-everdict-agent-name": "Everdict",
        "x-everdict-conversation-id": "conv-9",
      },
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.id } } },
    });

    expect(await judgeOrigin(app, "truncation", "1.0.0")).toMatchObject({
      agentId: "everdict",
      agentName: "Everdict",
      conversationId: "conv-9",
    });
  });

  it("keeps an unresolvable issue reference verbatim instead of dropping the provenance", async () => {
    const { app } = build();

    await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: "ENG-404" } } },
    });

    // No label (nothing to snapshot) and the id stays as written — a note about an issue the caller cannot read
    // is still better than none, and it renders as plain text rather than a link.
    expect(await judgeOrigin(app, "truncation", "1.0.0")).toEqual({
      via: "web",
      from: { type: "issue", id: "ENG-404" },
    });
  });

  it("a register may not DECLARE its own family as its origin — lineage is stamped, never claimed (review wave C)", async () => {
    // The harvester reads a same-family `from` as the version-lineage `succeeds` edge, and only the
    // platform's own writes (re-pin, bump) may say it — they resolve the base at the write. A caller
    // declaring its own family would mint that edge for a derivation that never happened (L3). Seen RED:
    // the forged declaration was stamped and the lineage edge became claimable from any register body.
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "judge", id: "truncation", version: "0.9.0" } } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("own family");
    // …while a DIFFERENT capability of the same type stays a legitimate born_from declaration.
    const sibling = await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "judge", id: "another-judge" } } },
    });
    expect(sibling.statusCode).toBe(201);
  });

  it("never lets the declaration leak into the spec — versions stay content-identical", async () => {
    // Given: a judge registered with an origin
    const { app } = build();
    const issue = await createIssue(app);
    await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.id } } },
    });

    // When: the identical spec is re-registered with a DIFFERENT origin
    const again = await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { note: "different story" } },
    });

    // Then: idempotent, not a 409 — provenance is metadata beside the spec, never part of it.
    expect(again.statusCode).toBe(201);
    const spec = await app.inject({ method: "GET", url: "/judges/truncation/versions/1.0.0", headers: H });
    expect(spec.json()).not.toHaveProperty("origin");
  });
});

describe("agent save origin — the upsert records why the version exists, and what it succeeds", () => {
  // The version-free save is the adoption path the evolve loop lands on, and it registered with no origin —
  // the same dropped-ancestry shape the harness re-pin had (evolution-lineage Track A follow-up).
  // RED as of 93e7b74f: versionOrigins was undefined for both the fresh save and the bump.
  const AGENT_BODY = {
    description: "workspace assistant",
    instructions: "be brief",
    mcpServers: [],
    capabilities: [],
    tags: [],
  };

  async function buildWithAgents() {
    const { InMemoryAgentRegistry } = await import("@everdict/registry");
    const { AgentService } = await import("../core/agent/agent-service.js");
    const agents = new InMemoryAgentRegistry();
    const issueStore = new InMemoryIssueStore();
    const issueService = new IssueService({
      teams: teamAllocator,
      store: issueStore,
      scorecards: new InMemoryScorecardStore(),
    });
    const agentService = new AgentService({ agents });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      issueService,
      agentRegistry: agents,
      agentService,
    });
    return { app, agents, agentService };
  }

  async function agentOrigin(
    agents: { list(tenant: string): Promise<Array<{ id: string; versionOrigins?: Record<string, unknown> }>> },
    version: string,
  ) {
    const entry = (await agents.list("acme")).find((e) => e.id === "helper");
    return entry?.versionOrigins?.[version];
  }

  it("a FRESH save records the caller's declared issue origin (born_from intent)", async () => {
    const { app, agents } = await buildWithAgents();
    const issue = await createIssue(app);
    const res = await app.inject({
      method: "PUT",
      url: "/agents/helper",
      headers: H,
      payload: { ...AGENT_BODY, origin: { from: { type: "issue", id: issue.id }, note: "born in a campaign" } },
    });
    expect(res.statusCode).toBe(200);
    expect(await agentOrigin(agents, "1.0.0")).toMatchObject({
      via: "web",
      from: { type: "issue", id: issue.id },
      note: "born in a campaign",
    });
  });

  it("a BUMP records the base version as its origin — the service knows the ancestor, the caller may not restate it", async () => {
    const { app, agents } = await buildWithAgents();
    await app.inject({ method: "PUT", url: "/agents/helper", headers: H, payload: AGENT_BODY });
    const bumped = await app.inject({
      method: "PUT",
      url: "/agents/helper",
      headers: H,
      payload: { ...AGENT_BODY, instructions: "be brief and cite ids" },
    });
    expect(bumped.statusCode).toBe(200);
    expect((bumped.json() as { version: string }).version).toBe("1.0.1");
    expect(await agentOrigin(agents, "1.0.1")).toMatchObject({
      via: "web",
      from: { type: "agent", id: "helper", version: "1.0.0" },
    });
  });

  it("a save that tries to RESTATE its own ancestry is refused at the door, and the service overrides the seam (review wave C)", async () => {
    // The ancestor is the one `from` a caller may not declare: only the bump's write knows the base, and a
    // caller-declared one would be a second spelling of that fact (L3) — a forged `succeeds` edge if it
    // named an older or foreign version. Two layers, both proven: the DOOR refuses the declaration
    // (`capabilityOriginFor` self check), and the SERVICE overrides `from` with the resolved base — the
    // seam a transport that forgot the door check would still hit.
    const { app, agents, agentService } = await buildWithAgents();
    await app.inject({ method: "PUT", url: "/agents/helper", headers: H, payload: AGENT_BODY });
    const restated = await app.inject({
      method: "PUT",
      url: "/agents/helper",
      headers: H,
      payload: {
        ...AGENT_BODY,
        instructions: "be brief and cite ids",
        origin: { from: { type: "agent", id: "helper", version: "0.0.1" }, note: "hand-written ancestry" },
      },
    });
    expect(restated.statusCode).toBe(400);
    expect((restated.json() as { message: string }).message).toContain("own family");
    // The service seam, driven directly with a smuggled self-family origin: the base it resolved wins.
    const bumped = await agentService.saveAgent(
      "acme",
      "u",
      "helper",
      {
        ...AGENT_BODY,
        instructions: "be brief and cite ids",
        disabledDefaults: [],
        toolSecretBindings: {},
        triggers: [],
        enabled: true,
      },
      { via: "web", from: { type: "agent", id: "helper", version: "0.0.1" }, note: "hand-written ancestry" },
    );
    expect(bumped.version).toBe("1.0.1");
    expect(await agentOrigin(agents, "1.0.1")).toMatchObject({
      via: "web",
      from: { type: "agent", id: "helper", version: "1.0.0" }, // the resolved base, never the restated 0.0.1
      note: "hand-written ancestry",
    });
  });

  it("a BUMP stays with the team that owns the agent (review wave C)", async () => {
    // Ownership is read off the newest version — a bump registered with no team moved the whole agent out
    // of its team's list the moment the new version became latest. Seen RED: the entry's teamId vanished.
    const { app, agents } = await buildWithAgents();
    await agents.register(
      "acme",
      {
        ...AGENT_BODY,
        id: "helper",
        version: "1.0.0",
        disabledDefaults: [],
        toolSecretBindings: {},
        triggers: [],
        enabled: true,
      },
      "alice",
      "team-eng",
    );
    const bumped = await app.inject({
      method: "PUT",
      url: "/agents/helper",
      headers: H,
      payload: { ...AGENT_BODY, instructions: "be brief and cite ids" },
    });
    expect(bumped.statusCode).toBe(200);
    expect((bumped.json() as { version: string }).version).toBe("1.0.1");
    const entry = (await agents.list("acme")).find((e) => e.id === "helper");
    expect(entry?.teamId).toBe("team-eng");
  });
});

// ── [R118 COUNTEREXAMPLE] SAVING AN AGENT IS A WRITE TO SOMEBODY'S AGENT ────────────────────────────
//
// `PUT /agents/:id` gates a bare `agents:write` with NO resource scope, on both transports. The service then
// PRESERVES the owner — correctly — so a member of another team saving over Team A's agent mints a new
// immutable Team-A-owned version they were never authorized to write. Preserving an owner and being allowed
// to write to it are different questions, which is the sentence the campaign adopt route already carries:
//
//   "a member of Team B holding `agents:write` could adopt a candidate owned by Team A and mint a
//    Team-A-owned successor"
//
// arch-review 76 closed that for the ADOPT door and did not look at the ordinary save door, where the same
// `agents:write` mints the same kind of version. The harness twin gates on `teamOfEntity` at both its write
// doors (register and re-pin); the agent lane gates on it at neither.
//
// ⚠️ `requireAuth` + a MEMBER authenticator: the dev-header fallback hands out `roles: ["admin"]`, and an
// admin governs every team BY DESIGN — an admin fixture "passes" this by bypassing the gate.
describe("[R118 COUNTEREXAMPLE] another team's agent cannot be saved over", () => {
  const AGENT_BODY = {
    description: "workspace assistant",
    instructions: "be brief",
    mcpServers: [],
    capabilities: [],
    tags: [],
  };

  async function memberOf(teams: string[]) {
    const { InMemoryAgentRegistry } = await import("@everdict/registry");
    const { AgentService } = await import("../core/agent/agent-service.js");
    const agents = new InMemoryAgentRegistry();
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      agentRegistry: agents,
      agentService: new AgentService({ agents }),
      teamService: {
        async list() {
          return teams.map((id) => ({ id }));
        },
        async defaultTeam() {
          return undefined;
        },
        async visibleTeamIds() {
          return undefined; // nothing hidden — this is about WRITING, not seeing
        },
        async canSeeTeam() {
          return true;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["teamService"]>,
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "u-b", workspace: "acme", roles: ["member"], teams, via: "oidc" as const };
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["authenticator"]>,
    });
    return { app, agents };
  }

  it("REFUSES a save over an agent owned by a team the caller is not on", async () => {
    const { app, agents } = await memberOf(["team-b"]);
    await agents.register(
      "acme",
      {
        ...AGENT_BODY,
        id: "helper",
        version: "1.0.0",
        disabledDefaults: [],
        toolSecretBindings: {},
        triggers: [],
        enabled: true,
      } as never,
      "u-a",
      "team-a",
    );

    const res = await app.inject({
      method: "PUT",
      url: "/agents/helper",
      headers: { authorization: "Bearer t" },
      payload: { ...AGENT_BODY, instructions: "do something else entirely" },
    });

    expect(res.statusCode, "another team's agent gained a version").toBe(403);
    expect(await agents.ownVersions("acme", "helper"), "the refused save registered a version anyway").toEqual([
      "1.0.0",
    ]);
  });

  it("ALLOWS the owning team — the control that keeps the gate from being a wall", async () => {
    const { app, agents } = await memberOf(["team-a"]);
    await agents.register(
      "acme",
      {
        ...AGENT_BODY,
        id: "helper",
        version: "1.0.0",
        disabledDefaults: [],
        toolSecretBindings: {},
        triggers: [],
        enabled: true,
      } as never,
      "u-a",
      "team-a",
    );

    const res = await app.inject({
      method: "PUT",
      url: "/agents/helper",
      headers: { authorization: "Bearer t" },
      payload: { ...AGENT_BODY, instructions: "do something else entirely" },
    });

    expect(res.statusCode, "the agent's own team was refused its edit").toBe(200);
    expect(res.json().created).toBe(true);
  });
});

// ── [R119 COUNTEREXAMPLE] AND THE MODEL SAVE DOOR, WHICH THE SAME WAVE DID NOT LOOK AT ──────────────
//
// R118 above closed the AGENT upsert. There are three version-free upsert doors — agent, model, capability
// — and it looked at one. The capability door is covered by its own service (creator-or-admin, refused
// before any write); the MODEL door had nothing: `ModelService.saveConnection` runs no authorization at all
// and both transports gated a bare `models:write` (member+). The one-lane-only shape, one wave later, in the
// door whose comment header is a near copy of the agent one.
//
// ⚠️ Its SHAPE changed mid-wave rather than appearing. Before the registry learned to preserve an entity's
// owner (arch-review 119), this door registered the successor with no team at all, which re-filed the model
// out of Team A — the quieter takeover. The store fix turned that into "a version minted inside a team the
// caller cannot write to". Both are wrong, and only the gate answers either.
//
// Same `requireAuth` + MEMBER authenticator, for the same reason: the dev-header fallback is an admin, and an
// admin governs every team by design.
describe("[R119 COUNTEREXAMPLE] another team's model cannot be saved over", () => {
  const MODEL_BODY = { provider: "anthropic", model: "claude-opus-4-8" };

  async function memberOf(teams: string[]) {
    const { InMemoryModelRegistry } = await import("@everdict/registry");
    const { ModelService } = await import("../core/model/model-service.js");
    const models = new InMemoryModelRegistry();
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      modelRegistry: models,
      modelService: new ModelService({ models, scopedSecretsFor: async () => ({ workspace: {}, user: {} }) }),
      teamService: {
        async list() {
          return teams.map((id) => ({ id }));
        },
        async defaultTeam() {
          return undefined;
        },
        async visibleTeamIds() {
          return undefined;
        },
        async canSeeTeam() {
          return true;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["teamService"]>,
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "u-b", workspace: "acme", roles: ["member"], teams, via: "oidc" as const };
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["authenticator"]>,
    });
    return { app, models };
  }

  const seed = async (models: { register: (...a: never[]) => Promise<void> }) =>
    models.register(
      ...(["acme", { ...MODEL_BODY, id: "opus", version: "1.0.0" }, "u-a", "team-a"] as unknown as never[]),
    );

  it("REFUSES a save over a model owned by a team the caller is not on, and writes nothing", async () => {
    const { app, models } = await memberOf(["team-b"]);
    await seed(models);

    const res = await app.inject({
      method: "PUT",
      url: "/models/opus",
      headers: { authorization: "Bearer t" },
      payload: { ...MODEL_BODY, model: "claude-sonnet-5" },
    });

    expect(res.statusCode, "another team's model gained a version").toBe(403);
    expect(await models.ownVersions("acme", "opus"), "the refused save registered a version anyway").toEqual(["1.0.0"]);
  });

  it("ALLOWS the owning team — the control", async () => {
    const { app, models } = await memberOf(["team-a"]);
    await seed(models);

    const res = await app.inject({
      method: "PUT",
      url: "/models/opus",
      headers: { authorization: "Bearer t" },
      payload: { ...MODEL_BODY, model: "claude-sonnet-5" },
    });

    expect(res.statusCode, "the model's own team was refused its edit").toBe(200);
    expect(res.json().created).toBe(true);
    expect(models.teamOfVersion("acme", "opus", "1.0.1"), "the successor left its team").toBe("team-a");
  });
});
