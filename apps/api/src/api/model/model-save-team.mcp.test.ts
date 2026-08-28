import type { Principal } from "@everdict/auth";
import { InMemoryModelRegistry } from "@everdict/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ModelService } from "../../core/model/model-service.js";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

// ── [R119 COUNTEREXAMPLE] SAVING A MODEL IS A WRITE TO SOMEBODY'S MODEL ─────────────────────────────
//
// arch-review 118 found that `save_agent` / `PUT /agents/:id` gated a bare `agents:write` with no resource
// scope while the service PRESERVES the owner, so a member of another team minted a Team-A-owned version
// they were never authorized to write. It closed the AGENT door.
//
// There are three version-free upsert doors — agent, model, capability — and only one was looked at. The
// capability door is covered by its service (creator-or-admin, refused before any write); the MODEL door has
// nothing: `ModelService.saveConnection` runs no authorization at all, and both transports gate a bare
// `models:write` (member+). The one-lane-only shape, third occurrence in this wave.
//
// The cost is the same sentence R118 wrote about agents: preserving an owner and being allowed to write to
// it are different questions.
//
// ⚠️ And the defect changed SHAPE mid-wave rather than appearing. Before the registry learned to preserve an
// entity's owner (arch-review 119), this door registered the successor with NO team, which RE-FILED the model
// out of Team A entirely — the quieter takeover. The store fix turned that into "a version minted inside a
// team the caller cannot write to". Both are wrong, and only the gate answers either.
//
// Seen RED on both transports before the fix:
//   "another team's model gained a version through MCP: expected [ '1.0.0', '1.0.1' ] to equal [ '1.0.0' ]"

const SPEC = JSON.stringify({ provider: "anthropic", model: "claude-opus-4-8" });

function makeDeps(): { deps: McpDeps; models: InMemoryModelRegistry } {
  const models = new InMemoryModelRegistry();
  const deps = {
    modelRegistry: models,
    // The save path never resolves a secret; the tier reader is required by the deps type and is what
    // `test_model_connection` uses — a fixture that supplies it honestly is one that cannot be read as
    // exercising a path it does not.
    modelService: new ModelService({ models, scopedSecretsFor: async () => ({ workspace: {}, user: {} }) }),
  } as unknown as McpDeps;
  return { deps, models };
}

async function connect(deps: McpDeps, teams: string[]): Promise<Client> {
  const principal: Principal = { subject: "user-a", workspace: "acme", roles: ["member"], via: "oidc", teams };
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const textOf = (r: unknown): string =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");

// Registered through the real registry with a team, exactly as `POST /models` does.
const seed = async (models: InMemoryModelRegistry) =>
  models.register(
    "acme",
    { id: "opus", version: "1.0.0", provider: "anthropic", model: "claude-opus-4-8" } as never,
    "u-a",
    "team-a",
  );

describe("[R119 COUNTEREXAMPLE] save_model refuses another team's model", () => {
  it("REFUSES, and registers nothing", async () => {
    const { deps, models } = makeDeps();
    await seed(models);
    const client = await connect(deps, ["team-b"]);

    const res = await client.callTool({
      name: "save_model",
      arguments: { id: "opus", model: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" }) },
    });

    expect(textOf(res), "another team's model gained a version through MCP").toMatch(
      /FORBIDDEN|not on the team|permission/i,
    );
    expect(await models.ownVersions("acme", "opus"), "the refused save registered a version anyway").toEqual(["1.0.0"]);
    // …and the entity is still Team A's, which is the half the registry guarantees.
    expect(models.teamOfVersion("acme", "opus", "1.0.0")).toBe("team-a");
  });

  it("ALLOWS the owning team — the control", async () => {
    const { deps, models } = makeDeps();
    await seed(models);
    const client = await connect(deps, ["team-a"]);

    const res = await client.callTool({
      name: "save_model",
      arguments: { id: "opus", model: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" }) },
    });

    expect(textOf(res), "the model's own team was refused its edit").not.toMatch(/FORBIDDEN/i);
    expect(await models.ownVersions("acme", "opus")).toEqual(["1.0.0", "1.0.1"]);
    expect(models.teamOfVersion("acme", "opus", "1.0.1"), "the successor left its team").toBe("team-a");
  });

  it("ALLOWS a brand-new id — a save that creates has no owner to be refused against", async () => {
    const { deps, models } = makeDeps();
    const client = await connect(deps, ["team-b"]);

    const res = await client.callTool({ name: "save_model", arguments: { id: "fresh", model: SPEC } });

    expect(textOf(res), "creating a new model was refused as though it belonged to somebody").not.toMatch(/FORBIDDEN/i);
    expect(await models.ownVersions("acme", "fresh")).toEqual(["1.0.0"]);
  });
});
