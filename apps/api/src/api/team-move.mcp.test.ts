import type { Principal } from "@everdict/auth";
import { DatasetSchema, NotFoundError } from "@everdict/contracts";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../mcp.js";
import type { McpDeps } from "./mcp-context.js";

// The MCP twin of the team-move routes (BFF↔MCP parity). The tools an agent gets are the same act with the same
// refusals — the whole point of the parity rule is that a capability an agent can use is one a person can, and
// vice versa.

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
};

// Parsed through the schema so the registry gets the same shape a route would hand it (defaults applied).
const dataset = (version: string, id = "swe-mini") =>
  DatasetSchema.parse({ id, version, cases: [{ id: "c1", env: { kind: "prompt" }, task: "hi", graders: [] }] });

async function connect(callerTeams: string[]): Promise<{ client: Client; datasets: InMemoryDatasetRegistry }> {
  const datasets = new InMemoryDatasetRegistry();
  await datasets.register("acme", dataset("1.0.0"), "alice", ENG);
  await datasets.register("acme", dataset("1.1.0"), "alice", ENG);
  const principal: Principal = {
    subject: "alice",
    workspace: "acme",
    roles: ["member"],
    via: "oidc",
    teams: callerTeams,
  };
  // biome-ignore lint/suspicious/noExplicitAny: only the two deps these tools touch are wired
  const deps = { datasetRegistry: datasets, teamService: teams as any } as unknown as McpDeps;
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, datasets };
}

const text = (r: unknown): string => (r as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";

describe("MCP move_dataset — the agent surface of ownership transfer", () => {
  it("moves every version and reports both teams", async () => {
    const { client, datasets } = await connect([ENG, PLATFORM]);

    const res = await client.callTool({ name: "move_dataset", arguments: { id: "swe-mini", team: PLATFORM } });

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({
      workspace: "acme",
      id: "swe-mini",
      teamId: PLATFORM,
      previousTeamId: ENG,
    });
    expect(await datasets.teamOfVersion("acme", "swe-mini", "1.1.0")).toBe(PLATFORM);
  });

  it("refuses a destination team the caller is not on — an agent acts as the person it acts for", async () => {
    const { client, datasets } = await connect([ENG]);

    const res = await client.callTool({ name: "move_dataset", arguments: { id: "swe-mini", team: PLATFORM } });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("FORBIDDEN");
    expect(await datasets.teamOfVersion("acme", "swe-mini", "1.0.0")).toBe(ENG);
  });

  it("names the team the way a person does — an unknown one is NOT_FOUND, not an empty success", async () => {
    const { client } = await connect([ENG, PLATFORM]);

    const res = await client.callTool({ name: "move_dataset", arguments: { id: "swe-mini", team: "team_ghost" } });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("NOT_FOUND");
  });

  it("list_datasets narrows to one team's own — the HTTP `?team=` filter, reachable by an agent", async () => {
    const { client, datasets } = await connect([ENG, PLATFORM]);
    await datasets.register("acme", dataset("1.0.0", "other"), "alice", PLATFORM);

    const eng = await client.callTool({ name: "list_datasets", arguments: { team: ENG } });
    expect(JSON.parse(text(eng)).map((e: { id: string }) => e.id)).toEqual(["swe-mini"]);

    const platform = await client.callTool({ name: "list_datasets", arguments: { team: PLATFORM } });
    expect(JSON.parse(text(platform)).map((e: { id: string }) => e.id)).toEqual(["other"]);
  });

  it("create_dataset files it under the named team, and refuses one the caller is not on", async () => {
    const { client, datasets } = await connect([ENG]);

    const mine = await client.callTool({
      name: "create_dataset",
      arguments: { dataset: JSON.stringify(dataset("1.0.0", "fresh")), team: ENG },
    });
    expect(mine.isError).toBeFalsy();
    expect(await datasets.teamOfVersion("acme", "fresh", "1.0.0")).toBe(ENG);

    const theirs = await client.callTool({
      name: "create_dataset",
      arguments: { dataset: JSON.stringify(dataset("1.0.0", "theirs")), team: PLATFORM },
    });
    expect(theirs.isError).toBe(true);
    expect(text(theirs)).toContain("FORBIDDEN");
  });
});
