import type { AgentRegistry, CapabilityStore, SecretStore, SkillStore } from "@everdict/application-control";
import {
  type AgentSpec,
  type CapabilityRecord,
  type CapabilityRef,
  type CapabilitySpec,
  NotFoundError,
  type SkillRecord,
} from "@everdict/contracts";
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

// A minimal CapabilityStore whose getVersion() resolves an adopted ref against the given records (cross-tenant raw).
function capabilityStore(records: CapabilityRecord[] = []): CapabilityStore {
  return {
    getVersion: async (owner: string, id: string, version: string) =>
      records.find((r) => r.tenant === owner && r.id === id && r.version === version),
  } as unknown as CapabilityStore;
}

const capRef = (over: Partial<CapabilityRef> = {}): CapabilityRef => ({
  source: "acme",
  id: "cap1",
  version: "1.0.0",
  secretBindings: {},
  enableWrite: false,
  ...over,
});

function capRecord(spec: CapabilitySpec, over: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    id: "cap1",
    tenant: "acme",
    version: "1.0.0",
    name: "cap",
    description: "d",
    spec,
    visibility: "public",
    sharedWith: [],
    tags: [],
    createdBy: "owner",
    createdAt: "t",
    ...over,
  };
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
  caps: CapabilityStore = capabilityStore(),
) {
  return registryProfileResolver({
    agentRegistry: agentRegistry(spec),
    secretStore: secrets,
    skillStore: skills,
    capabilityStore: caps,
    baseSystemPrompt: BASE,
    configId: "default",
  });
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { id: "default", version: "1.0.0", mcpServers: [], capabilities: [], tags: [], ...over };
}

describe("registryProfileResolver", () => {
  it("falls back to the base profile when no agent is registered", async () => {
    const profile = await resolver(undefined)(principal);
    expect(profile).toEqual({ systemPrompt: BASE, mcpServers: [], skills: [], codeTools: [] });
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

  it("resolves an adopted mcp capability into an MCP server (auth from the bound secret, write opt-in)", async () => {
    const cap = capRecord(
      {
        type: "mcp",
        url: "https://cap.example.com/mcp",
        provides: ["do_thing"],
        requiredSecrets: [{ name: "API_KEY", description: "the key" }],
        write: true,
      },
      { name: "shared-tools" },
    );
    const profile = await resolver(
      spec({ capabilities: [capRef({ secretBindings: { API_KEY: "my_key" }, enableWrite: true })] }),
      secretStore({ my_key: "Bearer cap-1" }),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.mcpServers).toEqual([
      { name: "shared-tools", url: "https://cap.example.com/mcp", authorization: "Bearer cap-1", write: true },
    ]);
  });

  it("does not enable write on an mcp capability unless the adopter opts in", async () => {
    const cap = capRecord({ type: "mcp", url: "https://c/mcp", provides: [], requiredSecrets: [], write: true });
    const profile = await resolver(
      spec({ capabilities: [capRef({ enableWrite: false })] }),
      secretStore({}),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.mcpServers[0]?.write).toBe(false);
  });

  it("resolves an adopted skill capability into a use_skill entry (deduped against the ambient library)", async () => {
    const cap = capRecord({ type: "skill", instructions: "1. adopted step" }, { name: "adopted-skill" });
    const profile = await resolver(
      spec({ capabilities: [capRef()] }),
      secretStore({}),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.skills).toContainEqual({ name: "adopted-skill", description: "d", instructions: "1. adopted step" });
    expect(profile.systemPrompt).toContain("use_skill");
  });

  it("skips a cross-tenant capability the consumer may not see (best-effort, turn survives)", async () => {
    const foreignPrivate = capRecord(
      { type: "mcp", url: "https://x/mcp", provides: [], requiredSecrets: [], write: false },
      { tenant: "beta", visibility: "private", createdBy: "someone" },
    );
    const profile = await resolver(
      spec({ capabilities: [capRef({ source: "beta" })] }),
      secretStore({}),
      skillStore(),
      capabilityStore([foreignPrivate]),
    )(principal);
    expect(profile.mcpServers).toEqual([]); // not visible to acme/u1 → skipped
  });

  it("skips an unresolvable capability pin without failing the turn", async () => {
    const profile = await resolver(
      spec({ capabilities: [capRef({ id: "gone", version: "9.9.9" })] }),
      secretStore({}),
      skillStore(),
      capabilityStore([]), // getVersion returns undefined
    )(principal);
    expect(profile.mcpServers).toEqual([]);
    expect(profile.skills).toEqual([]);
    expect(profile.codeTools).toEqual([]);
  });

  it("resolves an adopted code capability into a runnable code tool (env bound, sandbox flag from source)", async () => {
    const cap = capRecord(
      {
        type: "code",
        language: "python",
        code: "print('{}')",
        parametersSchema: { type: "object", properties: {} },
        isReadOnly: true,
        requiredSecrets: [{ name: "API_KEY", description: "k" }],
      },
      { name: "scorer", tenant: "beta", visibility: "public", createdBy: "owner" },
    );
    const profile = await resolver(
      spec({ capabilities: [capRef({ source: "beta", secretBindings: { API_KEY: "my_key" } })] }),
      secretStore({ my_key: "sk-9" }),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.codeTools).toEqual([
      {
        name: "scorer",
        description: "d",
        language: "python",
        code: "print('{}')",
        parametersSchema: { type: "object", properties: {} },
        isReadOnly: true,
        env: { API_KEY: "sk-9" },
        sandbox: true, // adopted from beta (source !== acme)
      },
    ]);
  });
});
