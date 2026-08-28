import { TeamService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import { InMemoryIssueStore, InMemoryTeamStore } from "@everdict/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../../mcp.js";
import { buildServer } from "../../server.js";
import type { McpDeps } from "../mcp-context.js";

// ── [R119 COUNTEREXAMPLE] A PRIVATE TEAM IS NOT DISCOVERABLE, AND NEITHER IS ITS ROSTER ─────────────
//
// `isPrivate` hides a team's work from everyone outside its roster, and `GET /teams/:id` already answers 404
// for a non-member. Two doors beside it did not:
//
//   · `GET /teams/:id/members` — gated `teams:read` and nothing else, so a private team's ROSTER was
//     readable by any viewer while the team itself was answered "not found". Learning WHO is on a team you
//     may not see is the thing being hidden, one field over.
//   · `get_team` (MCP) — the twin of the HTTP door that DOES call `canSeeTeam`. A gate one transport carries
//     and the other does not is the shape this wave kept finding (rule `api-layer`, BFF↔MCP parity).
//
// Found by `pnpm guard-siblings`, which asks the question mechanically: within one resource, an entity-naming
// door carries the guards its siblings carry.
//
// Seen RED before the fix:
//   "a private team's roster was readable by an outsider: expected 200 to be 404"
//   "an agent read a private team an outsider cannot see: expected 'ok' to contain NOT_FOUND"

const OUTSIDER = { subject: "outsider", workspace: "acme", roles: ["member"], via: "oidc" as const, teams: [] };

async function world() {
  const teams = new TeamService({ store: new InMemoryTeamStore(), issues: new InMemoryIssueStore() });
  const open = await teams.create({ tenant: "acme", key: "ENG", name: "Eng", createdBy: "system" });
  const secret = await teams.create({
    tenant: "acme",
    key: "SEC",
    name: "Secret",
    createdBy: "system",
    isPrivate: true,
  });
  await teams.addMember("acme", secret.id, "insider", { subject: "system" });
  return { teams, open, secret };
}

type ServerOptions = Parameters<typeof buildServer>[0];

// ⚠️ `requireAuth` + a MEMBER authenticator: the dev-header fallback hands out `roles: ["admin"]`, and an
// admin reaches every team BY DESIGN — an admin fixture "passes" this by bypassing the guard under test.
function http(teams: TeamService) {
  return buildServer({
    teamService: teams,
    requireAuth: true,
    authenticator: {
      async authenticate() {
        return OUTSIDER;
      },
    },
  } as unknown as ServerOptions);
}

async function mcp(teams: TeamService): Promise<Client> {
  const server = buildMcpServer({ teamService: teams } as unknown as McpDeps, OUTSIDER as unknown as Principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const AUTH = { authorization: "Bearer t" };
const textOf = (r: unknown): string =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");

describe("[R119 COUNTEREXAMPLE] a private team's roster and its MCP read are hidden too", () => {
  it("GET /teams/:id/members refuses a private team — the roster IS the thing being hidden", async () => {
    const { teams, secret } = await world();
    const app = http(teams);

    const res = await app.inject({ method: "GET", url: `/teams/${secret.id}/members`, headers: AUTH });

    expect(res.statusCode, "a private team's roster was readable by an outsider").toBe(404);
    await app.close();
  });

  it("get_team refuses it too — the twin of a route that already refuses", async () => {
    const { teams, secret } = await world();
    const client = await mcp(teams);

    const res = await client.callTool({ name: "get_team", arguments: { id: secret.id } });

    expect(textOf(res), "an agent read a private team an outsider cannot see").toContain("NOT_FOUND");
  });

  it("ALLOWS an open team through both doors — the control that keeps the gate from being a wall", async () => {
    const { teams, open } = await world();
    const app = http(teams);
    expect((await app.inject({ method: "GET", url: `/teams/${open.id}/members`, headers: AUTH })).statusCode).toBe(200);
    await app.close();

    const client = await mcp(teams);
    const res = await client.callTool({ name: "get_team", arguments: { id: open.id } });
    expect(textOf(res), "an open team was refused").not.toContain("NOT_FOUND");
  });
});
