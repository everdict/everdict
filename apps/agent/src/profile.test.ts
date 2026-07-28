import type { AgentRegistry, CapabilityStore, SecretStore, SkillStore } from "@everdict/application-control";
import {
  type AgentSpec,
  type CapabilityRecord,
  type CapabilityRef,
  type CapabilityRequirement,
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
    files: [],
    refs: [],
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
  integrations: readonly CapabilityRequirement[] = [],
) {
  return registryProfileResolver({
    agentRegistry: agentRegistry(spec),
    secretStore: secrets,
    skillStore: skills,
    capabilityStore: caps,
    baseSystemPrompt: BASE,
    configId: "default",
    integrationsConfigured: async () => integrations,
  });
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { id: "default", version: "1.0.0", mcpServers: [], capabilities: [], disabledDefaults: [], tags: [], ...over };
}

describe("registryProfileResolver", () => {
  it("falls back to the base profile when no agent is registered (+ the unconditional built-in defaults)", async () => {
    const profile = await resolver(undefined)(principal);
    expect(profile.systemPrompt).toBe(BASE);
    expect(profile.mcpServers).toEqual([]);
    expect(profile.skills).toEqual([]);
    // pdf_read is unconditional (no key); web_search needs a key (absent here) → omitted.
    expect(profile.codeTools.map((t) => t.name)).toEqual(["fetch_url", "pdf_read"]);
  });

  it("loads the workspace's skills into the profile (even with no agent registered) and notes them in the prompt", async () => {
    const profile = await resolver(
      undefined,
      secretStore({}),
      skillStore([skillRecord({ name: "triage" })]),
    )(principal);
    expect(profile.skills).toEqual([{ name: "triage", description: "d", instructions: "1. …", files: [] }]);
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
      { kind: "http", name: "tools", url: "https://mcp.example.com/mcp", authorization: "Bearer sk-123", write: false },
    ]);
  });

  it("leaves authorization unset when the referenced secret is absent", async () => {
    const profile = await resolver(
      spec({
        mcpServers: [{ name: "tools", url: "https://mcp.example.com/mcp", authSecret: "MISSING", write: false }],
      }),
    )(principal);
    expect(profile.mcpServers[0]).toEqual({
      kind: "http",
      name: "tools",
      url: "https://mcp.example.com/mcp",
      write: false,
    }); // no `authorization` key → the missing secret left it unset
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
        args: [],
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
      {
        kind: "http",
        name: "shared-tools",
        url: "https://cap.example.com/mcp",
        authorization: "Bearer cap-1",
        write: true,
      },
    ]);
  });

  it("resolves an adopted containerized (image) mcp capability into a stdio server, binding secrets to env", async () => {
    const cap = capRecord(
      {
        type: "mcp",
        image: "grafana/mcp-grafana",
        args: ["-t", "stdio"],
        provides: ["search_dashboards"],
        requiredSecrets: [
          { name: "GRAFANA_URL", description: "url" },
          { name: "GRAFANA_SERVICE_ACCOUNT_TOKEN", description: "token" },
        ],
        write: false,
      },
      { name: "grafana" },
    );
    const profile = await resolver(
      spec({
        capabilities: [capRef({ secretBindings: { GRAFANA_URL: "gf_url", GRAFANA_SERVICE_ACCOUNT_TOKEN: "gf_tok" } })],
      }),
      secretStore({ gf_url: "https://grafana.example.com", gf_tok: "glsa_abc" }),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.mcpServers).toEqual([
      {
        kind: "stdio",
        name: "grafana",
        image: "grafana/mcp-grafana",
        args: ["-t", "stdio"],
        env: { GRAFANA_URL: "https://grafana.example.com", GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_abc" },
        write: false,
      },
    ]);
  });

  it("skips an image mcp capability when a required secret is unbound (unconfigured → not offered)", async () => {
    const cap = capRecord(
      {
        type: "mcp",
        image: "grafana/mcp-grafana",
        args: [],
        provides: [],
        requiredSecrets: [{ name: "GRAFANA_URL", description: "url" }],
        write: false,
      },
      { name: "grafana" },
    );
    const profile = await resolver(
      spec({ capabilities: [capRef({ secretBindings: {} })] }), // GRAFANA_URL not bound
      secretStore({}),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.mcpServers).toEqual([]);
  });

  it("does not enable write on an mcp capability unless the adopter opts in", async () => {
    const cap = capRecord({
      type: "mcp",
      url: "https://c/mcp",
      args: [],
      provides: [],
      requiredSecrets: [],
      write: true,
    });
    const profile = await resolver(
      spec({ capabilities: [capRef({ enableWrite: false })] }),
      secretStore({}),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.mcpServers[0]?.write).toBe(false);
  });

  it("resolves an adopted skill capability into a use_skill entry (deduped against the ambient library)", async () => {
    const cap = capRecord({ type: "skill", instructions: "1. adopted step", files: [] }, { name: "adopted-skill" });
    const profile = await resolver(
      spec({ capabilities: [capRef()] }),
      secretStore({}),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.skills).toContainEqual({
      name: "adopted-skill",
      description: "d",
      instructions: "1. adopted step",
      files: [],
    });
    expect(profile.systemPrompt).toContain("use_skill");
  });

  it("skips a cross-tenant capability the consumer may not see (best-effort, turn survives)", async () => {
    const foreignPrivate = capRecord(
      { type: "mcp", url: "https://x/mcp", args: [], provides: [], requiredSecrets: [], write: false },
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
    expect(profile.codeTools.map((t) => t.name)).toEqual(["fetch_url", "pdf_read"]); // pin skipped; only the built-in defaults remain
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
        examples: [],
      },
      { name: "scorer", tenant: "beta", visibility: "public", createdBy: "owner" },
    );
    const profile = await resolver(
      spec({ capabilities: [capRef({ source: "beta", secretBindings: { API_KEY: "my_key" } })] }),
      secretStore({ my_key: "sk-9" }),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.codeTools.find((t) => t.name === "scorer")).toEqual({
      name: "scorer",
      description: "d",
      language: "python",
      code: "print('{}')",
      parametersSchema: { type: "object", properties: {} },
      isReadOnly: true,
      env: { API_KEY: "sk-9" },
      sandbox: true, // adopted from beta (source !== acme)
      examples: [],
    });
  });

  it("adds the built-in web_search default when a search key is available (even with no agent registered)", async () => {
    const profile = await resolver(undefined, secretStore({ TAVILY_API_KEY: "tvly-x" }))(principal);
    const tool = profile.codeTools.find((t) => t.name === "web_search");
    expect(tool).toBeDefined();
    expect(tool?.language).toBe("node");
    expect(tool?.isReadOnly).toBe(true);
    expect(tool?.sandbox).toBe(false); // first-party = trusted → runs on any driver
    expect(tool?.env).toEqual({ TAVILY_API_KEY: "tvly-x" });
  });

  it("omits the web_search default when no search key is configured (never offered broken)", async () => {
    const profile = await resolver(undefined)(principal);
    expect(profile.codeTools.some((t) => t.name === "web_search")).toBe(false); // no key → not offered (pdf_read still is)
  });

  it("lets a workspace opt out of a default via disabledDefaults", async () => {
    const profile = await resolver(
      spec({ disabledDefaults: ["web-search"] }),
      secretStore({ TAVILY_API_KEY: "tvly-x" }),
    )(principal);
    expect(profile.codeTools.some((t) => t.name === "web_search")).toBe(false); // opted out even though the key is present
  });

  it("adds the built-in scorecard_fix_pr SKILL default only when the GitHub integration is configured", async () => {
    // Gated default + integration configured → the skill rides into the profile (use_skill), no adoption needed.
    const withGithub = await resolver(undefined, secretStore({}), skillStore(), capabilityStore(), ["github"])(
      principal,
    );
    const skill = withGithub.skills.find((s) => s.name === "scorecard_fix_pr");
    expect(skill).toBeDefined();
    expect(skill?.instructions).toContain("open_github_pr");
    // No GitHub App installed → the gated default stays off (unconditional defaults are unaffected).
    const without = await resolver(undefined)(principal);
    expect(without.skills.some((s) => s.name === "scorecard_fix_pr")).toBe(false);
    expect(without.codeTools.map((t) => t.name)).toEqual(["fetch_url", "pdf_read"]);
  });

  it("a workspace-authored skill of the same name shadows the built-in skill default", async () => {
    const profile = await resolver(
      undefined,
      secretStore({}),
      skillStore([skillRecord({ name: "scorecard_fix_pr", instructions: "our own playbook" })]),
      capabilityStore(),
      ["github"],
    )(principal);
    const entries = profile.skills.filter((s) => s.name === "scorecard_fix_pr");
    expect(entries).toHaveLength(1); // shadowed, not duplicated
    expect(entries[0]?.instructions).toBe("our own playbook"); // the authored skill wins
  });

  it("shadows a default when an adopted tool has the same name", async () => {
    const shadow = capRecord(
      {
        type: "code",
        language: "python",
        code: "print('{}')",
        parametersSchema: { type: "object", properties: {} },
        isReadOnly: true,
        requiredSecrets: [],
        examples: [],
      },
      { name: "web_search" },
    );
    const profile = await resolver(
      spec({ capabilities: [capRef()] }),
      secretStore({ TAVILY_API_KEY: "tvly-x" }),
      skillStore(),
      capabilityStore([shadow]),
    )(principal);
    const webSearch = profile.codeTools.filter((t) => t.name === "web_search");
    expect(webSearch).toHaveLength(1); // the built-in default is shadowed, not duplicated
    expect(webSearch[0]?.language).toBe("python"); // the adopted tool, not the built-in node default
  });
});
