import type { AgentRegistry, SecretStore, SkillStore } from "@everdict/application-control";
import { type AgentSpec, NotFoundError, type SkillRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Principal } from "./principal.js";
import { registryProfileResolver } from "./profile.js";

const principal: Principal = { subject: "u1", workspace: "acme", roles: ["member"] };
const BASE = "BASE PROMPT";

// A minimal AgentRegistry whose get() returns a fixed spec (or throws NotFound to model an unregistered workspace).
function agentRegistry(spec: AgentSpec | undefined): AgentRegistry {
  return {
    get: async () => {
      if (!spec) throw new NotFoundError("NOT_FOUND", undefined, "no agent");
      return spec;
    },
  } as unknown as AgentRegistry;
}

// A minimal SecretStore whose scopedEntries() returns the two tiers.
function secretStore(workspace: Record<string, string>, user: Record<string, string> = {}): SecretStore {
  return { scopedEntries: async () => ({ workspace, user }) } as unknown as SecretStore;
}

// A minimal SkillStore whose list() returns the given records.
function skillStore(records: SkillRecord[] = []): SkillStore {
  return { list: async () => records } as unknown as SkillStore;
}

function skillRecord(over: Partial<SkillRecord>): SkillRecord {
  return {
    id: "s1",
    tenant: "acme",
    name: "triage",
    description: "d",
    instructions: "1. …",
    visibility: "workspace",
    createdBy: "u1",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

function resolver(
  spec: AgentSpec | undefined,
  secrets: SecretStore = secretStore({}),
  skills: SkillStore = skillStore(),
) {
  return registryProfileResolver({
    agentRegistry: agentRegistry(spec),
    secretStore: secrets,
    skillStore: skills,
    baseSystemPrompt: BASE,
    configId: "default",
  });
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { id: "default", version: "1.0.0", mcpServers: [], tags: [], ...over };
}

describe("registryProfileResolver", () => {
  it("falls back to the base profile when no agent is registered", async () => {
    const profile = await resolver(undefined)(principal);
    expect(profile).toEqual({ systemPrompt: BASE, mcpServers: [], skills: [] });
  });

  it("loads the workspace's skills into the profile (even with no agent registered) and notes them in the prompt", async () => {
    const profile = await resolver(
      undefined,
      secretStore({}),
      skillStore([skillRecord({ name: "triage" })]),
    )(principal);
    expect(profile.skills).toEqual([{ name: "triage", description: "d", instructions: "1. …" }]);
    expect(profile.systemPrompt).toContain("use_skill");
  });

  it("appends the workspace instructions to the base system prompt", async () => {
    const profile = await resolver(spec({ instructions: "Prefer WebArena." }))(principal);
    expect(profile.systemPrompt).toContain(BASE);
    expect(profile.systemPrompt).toContain("Prefer WebArena.");
    expect(profile.systemPrompt.indexOf(BASE)).toBeLessThan(profile.systemPrompt.indexOf("Prefer WebArena."));
  });

  it("surfaces the model override", async () => {
    const profile = await resolver(spec({ model: "agent-llm" }))(principal);
    expect(profile.model).toBe("agent-llm");
  });

  it("resolves an MCP server's authSecret to a verbatim Authorization value from the workspace tier", async () => {
    const profile = await resolver(
      spec({
        mcpServers: [{ name: "tools", url: "https://mcp.example.com/mcp", authSecret: "MCP_KEY", write: false }],
      }),
      secretStore({ MCP_KEY: "Bearer sk-123" }),
    )(principal);
    expect(profile.mcpServers).toEqual([
      { name: "tools", url: "https://mcp.example.com/mcp", authorization: "Bearer sk-123", write: false },
    ]);
  });

  it("leaves authorization unset when the referenced secret is absent", async () => {
    const profile = await resolver(
      spec({
        mcpServers: [{ name: "tools", url: "https://mcp.example.com/mcp", authSecret: "MISSING", write: false }],
      }),
    )(principal);
    expect(profile.mcpServers[0]).toEqual({ name: "tools", url: "https://mcp.example.com/mcp", write: false });
    expect(profile.mcpServers[0]?.authorization).toBeUndefined();
  });

  it("notes the write-tool caveat in the prompt when a server is write-allowed", async () => {
    const readOnly = await resolver(
      spec({ mcpServers: [{ name: "ro", url: "https://mcp.example.com/mcp", write: false }] }),
    )(principal);
    expect(readOnly.systemPrompt).not.toContain("can make");

    const writeable = await resolver(
      spec({ mcpServers: [{ name: "rw", url: "https://mcp.example.com/mcp", write: true }] }),
    )(principal);
    expect(writeable.systemPrompt).toContain("can make");
    expect(writeable.mcpServers[0]?.write).toBe(true);
  });
});
