import type { Principal } from "@everdict/auth";
import { NotFoundError } from "@everdict/contracts";
import {
  InMemoryAgentRegistry,
  InMemoryModelRegistry,
  InMemoryRubricRegistry,
  InMemoryRuntimeRegistry,
} from "@everdict/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../mcp.js";
import type { McpDeps } from "./mcp-context.js";

// ── [R119 COUNTEREXAMPLE] A CAPABILITY REGISTERED THROUGH MCP BELONGS TO A TEAM ─────────────────────
//
// Four register doors — rubric, model, runtime, agent — wrote with NO team while their HTTP twins resolve
// one through `teamForNew` and file the asset under it. `judge` and `harness` already carried `runForTeam`,
// so the correct shape was two files away from each of the four (arch-review 119).
//
// What that costs is not cosmetic. Ownership is read off an entity's versions, so an asset born unowned is
// visible to every team and writable without a team gate — and worse, registering a NEW version of a
// team-owned id through one of these tools re-files the whole entity out of its team, because
// `teamOfEntity` answers off the newest version. A member on no team could de-team another team's rubric
// by registering `2.0.0` over it.
//
// The `rubric` door carried the comment "creator stamp — HTTP parity" over the one call that broke parity,
// which is the comment-is-a-claim law with the promised component being the sibling transport.
//
// Seen RED, all four, before the fix:
//   "AssertionError: expected undefined to be 'team_eng' — a capability registered over MCP belongs to nobody"
// and the refusal cases returned `isError: false` because there was no team argument to refuse.

const ENG = "team_eng";
const PLATFORM = "team_platform";

const teams = {
  async resolveId(_tenant: string, ref: string) {
    if (![ENG, PLATFORM].includes(ref)) throw new NotFoundError("NOT_FOUND", { team: ref }, "Team not found.");
    return ref;
  },
  async visibleTeamIds() {
    return undefined;
  },
  async canSeeTeam() {
    return true;
  },
  // `teamForNew` with no explicit choice lands the asset in the caller's own team — the rule the HTTP twins
  // follow, and the one that makes "absent" mean something other than "unowned".
  async defaultTeamId() {
    return ENG;
  },
};

interface Registries {
  agents: InMemoryAgentRegistry;
  models: InMemoryModelRegistry;
  runtimes: InMemoryRuntimeRegistry;
  rubrics: InMemoryRubricRegistry;
}

async function connect(callerTeams: string[]): Promise<{ client: Client; registries: Registries }> {
  const registries: Registries = {
    agents: new InMemoryAgentRegistry(),
    models: new InMemoryModelRegistry(),
    runtimes: new InMemoryRuntimeRegistry(),
    rubrics: new InMemoryRubricRegistry(),
  };
  const principal: Principal = {
    subject: "alice",
    workspace: "acme",
    roles: ["member"],
    via: "oidc",
    teams: callerTeams,
  };
  const deps = {
    agentRegistry: registries.agents,
    modelRegistry: registries.models,
    runtimeRegistry: registries.runtimes,
    rubricRegistry: registries.rubrics,
    // biome-ignore lint/suspicious/noExplicitAny: only the team resolver these tools reach is wired
    teamService: teams as any,
  } as unknown as McpDeps;
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, registries };
}

const text = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("");

// One row per door: the tool, the argument carrying the spec, a minimal spec the real schema accepts, and
// the registry to read the landed team back off. Driving them from one table is deliberate — the defect was
// four spellings of one act, and a table makes a fifth door that forgets impossible to add quietly.
const DOORS = [
  {
    tool: "create_rubric",
    arg: "rubric",
    spec: { id: "concision", version: "1.0.0", text: "Is the answer short?" },
    registry: (r: Registries) => r.rubrics,
  },
  {
    tool: "create_model",
    arg: "model",
    spec: { id: "opus", version: "1.0.0", provider: "anthropic", model: "claude-opus-4-8" },
    registry: (r: Registries) => r.models,
  },
  {
    tool: "create_runtime",
    arg: "runtime",
    spec: { kind: "nomad", id: "seoul", version: "1.0.0", addr: "http://nomad:4646", image: "ghcr.io/acme/a:1" },
    registry: (r: Registries) => r.runtimes,
  },
  {
    tool: "create_agent",
    arg: "agent",
    spec: { id: "helper", version: "1.0.0", instructions: "be brief", mcpServers: [] },
    registry: (r: Registries) => r.agents,
  },
] as const;

describe("[R119 COUNTEREXAMPLE] MCP capability registration files the asset under a team", () => {
  for (const door of DOORS) {
    it(`${door.tool}: an explicit team the caller is on OWNS the registered version`, async () => {
      const { client, registries } = await connect([ENG, PLATFORM]);

      const res = await client.callTool({
        name: door.tool,
        arguments: { [door.arg]: JSON.stringify(door.spec), team: PLATFORM },
      });

      expect(res.isError, text(res)).toBeFalsy();
      expect(
        door.registry(registries).teamOfVersion("acme", door.spec.id, "1.0.0"),
        "a capability registered over MCP belongs to nobody",
      ).toBe(PLATFORM);
    });

    it(`${door.tool}: naming a team the caller is NOT on is refused, and registers nothing`, async () => {
      const { client, registries } = await connect([ENG]);

      const res = await client.callTool({
        name: door.tool,
        arguments: { [door.arg]: JSON.stringify(door.spec), team: PLATFORM },
      });

      expect(res.isError, "an agent filed a capability under a team its person may not write to").toBe(true);
      expect(text(res)).toMatch(/FORBIDDEN|NOT_FOUND/);
      // The WORLD, not the answer: a refusal after the row exists is not a refusal (rule `protocol`).
      expect(await door.registry(registries).ownVersions("acme", door.spec.id)).toEqual([]);
    });

    it(`${door.tool}: no team named lands it in the caller's own team, never unowned`, async () => {
      const { client, registries } = await connect([ENG]);

      const res = await client.callTool({ name: door.tool, arguments: { [door.arg]: JSON.stringify(door.spec) } });

      expect(res.isError, text(res)).toBeFalsy();
      expect(
        door.registry(registries).teamOfVersion("acme", door.spec.id, "1.0.0"),
        "an unnamed team was read as 'unowned' rather than as the caller's own",
      ).toBe(ENG);
    });
  }
});
