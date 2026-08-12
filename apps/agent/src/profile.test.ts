import type {
  AgentMemberPreferenceStore,
  AgentRegistry,
  CapabilityStore,
  SecretStore,
  SkillStore,
} from "@everdict/application-control";
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
import { registryProfileResolver, registrySubagentTypes } from "./profile.js";

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
    version: "1.0.0",
    createdBy: "u1",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

// A minimal per-member overlay whose get() returns the given decisions for every member (tests pass one member's).
function memberPreferences(
  tools: Record<string, boolean>,
  skills: Record<string, boolean> = {},
  model: string | null = null,
): AgentMemberPreferenceStore {
  const state = (tenant: string, subject: string) => ({ tenant, subject, tools, skills, model, updatedAt: "t" });
  return {
    get: async (tenant, subject) => state(tenant, subject),
    setEntry: async (tenant, subject) => state(tenant, subject),
    setModel: async (tenant, subject) => state(tenant, subject),
  };
}

function resolver(
  spec: AgentSpec | undefined,
  secrets: SecretStore = secretStore({}),
  skills: SkillStore = skillStore(),
  caps: CapabilityStore = capabilityStore(),
  integrations: readonly CapabilityRequirement[] = [],
  preferences?: AgentMemberPreferenceStore,
) {
  return registryProfileResolver({
    agentRegistry: agentRegistry(spec),
    secretStore: secrets,
    skillStore: skills,
    capabilityStore: caps,
    baseSystemPrompt: BASE,
    configId: "default",
    integrationsConfigured: async () => integrations,
    ...(preferences ? { preferences } : {}),
  });
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: "default",
    version: "1.0.0",
    mcpServers: [],
    capabilities: [],
    disabledDefaults: [],
    toolSecretBindings: {},
    triggers: [],
    enabled: false,
    tags: [],
    ...over,
  };
}

describe("registryProfileResolver", () => {
  it("falls back to the base profile when no agent is registered (+ the unconditional built-in defaults)", async () => {
    const profile = await resolver(undefined)(principal);
    // Nothing is registered and the workspace owns no skill, so the library is empty: Everdict's own skills are
    // store EXAMPLES a workspace copies in, never documents that attach themselves.
    expect(profile.systemPrompt.startsWith(BASE)).toBe(true);
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
    expect(profile.skills.map((s) => s.name)).toEqual(["triage"]);
    expect(profile.skills[0]).toMatchObject({ name: "triage", description: "d", instructions: "1. …", files: [] });
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

  it("the member's own default model outranks the workspace agent's", async () => {
    const profile = await resolver(
      spec({ model: "agent-llm" }),
      secretStore({}),
      skillStore(),
      capabilityStore(),
      [],
      memberPreferences({}, {}, "my-llm"),
    )(principal);
    expect(profile.model).toBe("my-llm");
  });

  it("a member who picked no model still follows the workspace agent's", async () => {
    const profile = await resolver(
      spec({ model: "agent-llm" }),
      secretStore({}),
      skillStore(),
      capabilityStore(),
      [],
      memberPreferences({}, {}, null),
    )(principal);
    expect(profile.model).toBe("agent-llm");
  });

  it("a CRAFTED agent keeps its declared model — its instrument is its identity, not the member's taste", async () => {
    const profile = await resolver(
      spec({ id: "triage-bot", model: "agent-llm" }),
      secretStore({}),
      skillStore(),
      capabilityStore(),
      [],
      memberPreferences({}, {}, "my-llm"),
    )(principal, "triage-bot");
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

  it("never turns a skill-kind capability into a use_skill entry — a store skill reaches the agent by being COPIED", async () => {
    // A stale pin from before skills were copies must not smuggle an uneditable procedure into the library; the
    // supported path is SkillService.importFromStore, which lands a SkillRecord the workspace owns.
    const cap = capRecord({ type: "skill", instructions: "1. published step", files: [] }, { name: "published-skill" });
    const profile = await resolver(
      spec({ capabilities: [capRef()] }),
      secretStore({}),
      skillStore(),
      capabilityStore([cap]),
    )(principal);
    expect(profile.skills).toEqual([]);
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

  it("offers no skill at all until the workspace owns one — not even with every integration configured", async () => {
    const configured = await resolver(undefined, secretStore({}), skillStore(), capabilityStore(), ["github"])(
      principal,
    );
    expect(configured.skills).toEqual([]);
    expect(configured.codeTools.map((t) => t.name)).toEqual(["fetch_url", "pdf_read"]); // tools still ride along
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
  // The per-MEMBER toolset: the workspace AgentSpec is the baseline, each member's own decisions sit on top, so the
  // same assistant does NOT answer every member of a workspace with the same tools.
  it("drops a workspace tool the member switched off, without touching the workspace's agent", async () => {
    const adopted = capRecord(
      {
        type: "code",
        language: "python",
        code: "print('{}')",
        parametersSchema: { type: "object", properties: {} },
        isReadOnly: true,
        requiredSecrets: [],
        examples: [],
      },
      { name: "jira" },
    );
    const args = [
      spec({ capabilities: [capRef()] }),
      secretStore({}),
      skillStore(),
      capabilityStore([adopted]),
      [] as readonly CapabilityRequirement[],
    ] as const;
    const asIs = await resolver(...args)(principal);
    expect(asIs.codeTools.map((t) => t.name)).toContain("jira");

    const optedOut = await resolver(...args, memberPreferences({ "capability:acme/cap1": false }))(principal);
    expect(optedOut.codeTools.map((t) => t.name)).not.toContain("jira");
  });

  it("carries a tool the member switched on that the workspace never adopted", async () => {
    const mine = capRecord(
      {
        type: "code",
        language: "python",
        code: "print('{}')",
        parametersSchema: { type: "object", properties: {} },
        isReadOnly: true,
        requiredSecrets: [],
        examples: [],
      },
      { id: "scratch", name: "scratch", tenant: "acme", visibility: "private", createdBy: "u1" },
    );
    const caps = {
      getVersion: async () => undefined,
      listVisible: async () => [mine],
    } as unknown as CapabilityStore;
    const off = await resolver(spec(), secretStore({}), skillStore(), caps)(principal);
    expect(off.codeTools.map((t) => t.name)).not.toContain("scratch");

    const on = await resolver(
      spec(),
      secretStore({}),
      skillStore(),
      caps,
      [],
      memberPreferences({ "capability:acme/scratch": true }),
    )(principal);
    expect(on.codeTools.map((t) => t.name)).toContain("scratch");
  });

  it("lets a member re-enable a built-in default their workspace opted out of", async () => {
    const optedOut = spec({ disabledDefaults: ["web-search"] });
    const secrets = secretStore({ TAVILY_API_KEY: "tvly-x" });
    const workspaceDefault = await resolver(optedOut, secrets)(principal);
    expect(workspaceDefault.codeTools.map((t) => t.name)).not.toContain("web_search");

    const mine = await resolver(
      optedOut,
      secrets,
      skillStore(),
      capabilityStore(),
      [],
      memberPreferences({ "default:web-search": true }),
    )(principal);
    expect(mine.codeTools.map((t) => t.name)).toContain("web_search");
  });
  // Skills are per-member too: the workspace library says which procedures exist, the member says which ones their
  // agent follows.
  it("drops a workspace skill the member switched off, without touching the library", async () => {
    const library = skillStore([skillRecord({ name: "triage", id: "s-triage" })]);
    const asIs = await resolver(undefined, secretStore({}), library)(principal);
    expect(asIs.skills.map((s) => s.name)).toContain("triage");

    const optedOut = await resolver(
      undefined,
      secretStore({}),
      library,
      capabilityStore(),
      [],
      memberPreferences({}, { "skill:s-triage": false }),
    )(principal);
    expect(optedOut.skills.map((s) => s.name)).not.toContain("triage");
  });
});

describe("registrySubagentTypes — crafted agents as spawnable sub-agent roles", () => {
  const spec = (id: string, extra: Partial<AgentSpec> = {}): AgentSpec =>
    ({ id, version: "1.0.0", mcpServers: [], capabilities: [], disabledDefaults: [], ...extra }) as AgentSpec;
  const principal = { subject: "u-1", workspace: "acme", roles: ["member"] };

  function listingRegistry(specs: AgentSpec[]): AgentRegistry {
    return {
      list: async () => specs.map((s) => ({ id: s.id, versions: [s.version], owner: "acme" })),
      get: async (_tenant: string, id: string) => {
        const found = specs.find((s) => s.id === id);
        if (!found) throw new Error("not found");
        return found;
      },
    } as unknown as AgentRegistry;
  }

  it("maps registered agents with instructions to spawnable types, excluding the chat's own config agent", async () => {
    const lister = registrySubagentTypes(
      listingRegistry([
        spec("default", { instructions: "the chat persona itself" }),
        spec("triage-bot", { instructions: "Triage regressions by severity", description: "regression triager" }),
        spec("no-role"), // instruction-less → not a spawnable role
      ]),
      "default",
    );
    const types = await lister(principal);
    expect(types).toEqual([
      { name: "triage-bot", description: "regression triager", instructions: "Triage regressions by severity" },
    ]);
  });

  it("caps the listing and degrades to no types when the registry is unreachable", async () => {
    const many = Array.from({ length: 20 }, (_, i) => spec(`a-${i}`, { instructions: `role ${i}` }));
    expect(await registrySubagentTypes(listingRegistry(many), "default", 3)(principal)).toHaveLength(3);
    const broken = {
      list: async () => {
        throw new Error("db down");
      },
    } as unknown as AgentRegistry;
    expect(await registrySubagentTypes(broken, "default")(principal)).toEqual([]);
  });
});
