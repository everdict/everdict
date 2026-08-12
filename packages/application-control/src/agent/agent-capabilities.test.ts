import type { AgentMemberPreferences, AgentSpec, CapabilityRecord, SkillRecord } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { AgentMemberPreferenceStore } from "../ports/agent-member-preference-store.js";
import type { AgentRegistry } from "../ports/agent-registry.js";
import type { CapabilityStore } from "../ports/capability-store.js";
import type { SkillStore } from "../ports/skill-store.js";
import { type AgentCapabilitiesDeps, resolveAgentCapabilities } from "./agent-capabilities.js";

const TENANT = "acme";

function codeCapability(over: Partial<CapabilityRecord> & Pick<CapabilityRecord, "id" | "name">): CapabilityRecord {
  return {
    tenant: TENANT,
    version: "1.0.0",
    description: `${over.name} tool`,
    spec: {
      type: "code",
      language: "python",
      code: "print(1)",
      parametersSchema: {},
      isReadOnly: true,
      requiredSecrets: [],
      examples: [],
    },
    visibility: "workspace",
    sharedWith: [],
    tags: [],
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// Fakes — the ports only, so the use-case is exercised without a database (skill `testing`).
function fakeRegistry(spec: AgentSpec | undefined): AgentRegistry {
  return {
    register: async () => {},
    has: async () => spec !== undefined,
    get: async () => {
      if (!spec) throw new NotFoundError("NOT_FOUND", undefined, "no agent");
      return spec;
    },
    versions: async () => [],
    ownVersions: async () => [],
    list: async () => [],
    creatorOf: async () => undefined,
    softDelete: async () => {},
  };
}

function fakeCapabilities(records: CapabilityRecord[]): CapabilityStore {
  return {
    register: async () => {},
    get: async (tenant, id) => records.find((r) => r.tenant === tenant && r.id === id),
    getVersion: async (owner, id, version) =>
      records.find((r) => r.tenant === owner && r.id === id && r.version === version),
    versions: async () => [],
    listVisible: async (tenant, subject) =>
      records.filter((r) => r.tenant === tenant && (r.visibility !== "private" || r.createdBy === subject)),
    listPublic: async () => [],
    setVisibility: async () => {},
    setVersionTags: async () => {},
    versionTags: async () => ({}),
    softDelete: async () => {},
    creatorOfVersion: async () => undefined,
  };
}

function fakePreferences(
  tools: Record<string, boolean>,
  skills: Record<string, boolean> = {},
): AgentMemberPreferenceStore {
  const state: AgentMemberPreferences = {
    tenant: TENANT,
    subject: "alice",
    tools,
    skills,
    model: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { get: async () => state, setEntry: async () => state, setModel: async () => state };
}

// A minimal SkillStore whose list() returns the given authored records.
function fakeSkills(records: SkillRecord[]): SkillStore {
  return {
    create: async () => {},
    get: async () => undefined,
    list: async () => records,
    update: async () => undefined,
    remove: async () => {},
  };
}

function skillRecord(over: Partial<SkillRecord> & Pick<SkillRecord, "id" | "name">): SkillRecord {
  return {
    tenant: TENANT,
    description: `${over.name} procedure`,
    instructions: "1. …",
    version: "1.0.0",
    files: [],
    refs: [],
    visibility: "workspace",
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const agentSpec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
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
});

const deps = (over: Partial<AgentCapabilitiesDeps> = {}): AgentCapabilitiesDeps => ({
  agentRegistry: fakeRegistry(agentSpec()),
  capabilityStore: fakeCapabilities([]),
  ...over,
});

const query = { tenant: TENANT, subject: "alice", agentId: "default" };
const keyed = (resolution: Awaited<ReturnType<typeof resolveAgentCapabilities>>, key: string) =>
  resolution.tools.find((t) => t.key === key);
const skillKeyed = (resolution: Awaited<ReturnType<typeof resolveAgentCapabilities>>, key: string) =>
  resolution.skills.find((s) => s.key === key);

describe("resolveAgentCapabilities", () => {
  it("puts an adopted capability on the table for everyone (baseline enabled)", async () => {
    const jira = codeCapability({ id: "jira", name: "jira" });
    const tools = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({
            capabilities: [{ source: TENANT, id: "jira", version: "1.0.0", secretBindings: {}, enableWrite: false }],
          }),
        ),
        capabilityStore: fakeCapabilities([jira]),
      }),
      query,
    );
    const entry = keyed(tools, "capability:acme/jira");
    expect(entry?.enabled).toBe(true);
    expect(entry?.baseline).toBe(true);
    expect(entry?.scope).toBe("workspace");
  });

  it("lists an authored-but-unadopted workspace tool as available and OFF", async () => {
    const tools = await resolveAgentCapabilities(
      deps({ capabilityStore: fakeCapabilities([codeCapability({ id: "draft", name: "draft" })]) }),
      query,
    );
    const entry = keyed(tools, "capability:acme/draft");
    expect(entry?.baseline).toBe(false);
    expect(entry?.enabled).toBe(false);
  });

  it("scopes the caller's own private publication as personal and hides other members'", async () => {
    const capabilities = fakeCapabilities([
      codeCapability({ id: "mine", name: "mine", visibility: "private", createdBy: "alice" }),
      codeCapability({ id: "theirs", name: "theirs", visibility: "private", createdBy: "bob" }),
    ]);
    const tools = await resolveAgentCapabilities(deps({ capabilityStore: capabilities }), query);
    expect(keyed(tools, "capability:acme/mine")?.scope).toBe("personal");
    expect(keyed(tools, "capability:acme/theirs")).toBeUndefined();
  });

  it("gives two members of one workspace different toolsets", async () => {
    const shared = {
      agentRegistry: fakeRegistry(
        agentSpec({
          capabilities: [{ source: TENANT, id: "jira", version: "1.0.0", secretBindings: {}, enableWrite: false }],
        }),
      ),
      capabilityStore: fakeCapabilities([codeCapability({ id: "jira", name: "jira" })]),
    };
    const alice = await resolveAgentCapabilities(deps({ ...shared, preferences: fakePreferences({}) }), query);
    const bob = await resolveAgentCapabilities(
      deps({ ...shared, preferences: fakePreferences({ "capability:acme/jira": false }) }),
      { ...query, subject: "bob" },
    );
    expect(keyed(alice, "capability:acme/jira")?.enabled).toBe(true);
    expect(keyed(bob, "capability:acme/jira")?.enabled).toBe(false);
  });

  it("lets a member switch on a tool the workspace never adopted", async () => {
    const tools = await resolveAgentCapabilities(
      deps({
        capabilityStore: fakeCapabilities([codeCapability({ id: "draft", name: "draft" })]),
        preferences: fakePreferences({ "capability:acme/draft": true }),
      }),
      query,
    );
    expect(keyed(tools, "capability:acme/draft")?.enabled).toBe(true);
  });

  it("remaps a built-in default's declared secret through the spec-level overlay", async () => {
    const tools = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({ toolSecretBindings: { "default:web-search": { TAVILY_API_KEY: "MY_KEY" } } }),
        ),
      }),
      query,
    );
    expect(keyed(tools, "default:web-search")?.secretBindings).toEqual({ TAVILY_API_KEY: "MY_KEY" });
  });

  it("remaps an unadopted publication's secrets, ignoring names the tool no longer declares", async () => {
    const grafana = codeCapability({ id: "grafana", name: "grafana" });
    grafana.spec = {
      ...grafana.spec,
      requiredSecrets: [{ name: "API_KEY", description: "token" }],
    } as typeof grafana.spec;
    const tools = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({ toolSecretBindings: { "capability:acme/grafana": { API_KEY: "MY_KEY", GONE: "STALE" } } }),
        ),
        capabilityStore: fakeCapabilities([grafana]),
      }),
      query,
    );
    expect(keyed(tools, "capability:acme/grafana")?.secretBindings).toEqual({ API_KEY: "MY_KEY" });
  });

  it("never lets the overlay override an adopted reference's own binding map", async () => {
    const grafana = codeCapability({ id: "grafana", name: "grafana" });
    grafana.spec = {
      ...grafana.spec,
      requiredSecrets: [{ name: "API_KEY", description: "token" }],
    } as typeof grafana.spec;
    const tools = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({
            capabilities: [
              {
                source: TENANT,
                id: "grafana",
                version: "1.0.0",
                secretBindings: { API_KEY: "REF_KEY" },
                enableWrite: false,
              },
            ],
            toolSecretBindings: { "capability:acme/grafana": { API_KEY: "OVERLAY_KEY" } },
          }),
        ),
        capabilityStore: fakeCapabilities([grafana]),
      }),
      query,
    );
    expect(keyed(tools, "capability:acme/grafana")?.secretBindings).toEqual({ API_KEY: "REF_KEY" });
  });

  it("offers the first-party defaults, and honors the workspace opt-out as the baseline", async () => {
    const on = await resolveAgentCapabilities(deps(), query);
    expect(keyed(on, "default:web-search")?.enabled).toBe(true);
    const off = await resolveAgentCapabilities(
      deps({ agentRegistry: fakeRegistry(agentSpec({ disabledDefaults: ["web-search"] })) }),
      query,
    );
    expect(keyed(off, "default:web-search")?.baseline).toBe(false);
    // …and a member can still switch it back on for themselves.
    const back = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(agentSpec({ disabledDefaults: ["web-search"] })),
        preferences: fakePreferences({ "default:web-search": true }),
      }),
      query,
    );
    expect(keyed(back, "default:web-search")?.enabled).toBe(true);
  });

  it("shadows a first-party default when an enabled tool of the same name is present", async () => {
    const tools = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({
            capabilities: [{ source: TENANT, id: "search", version: "1.0.0", secretBindings: {}, enableWrite: false }],
          }),
        ),
        capabilityStore: fakeCapabilities([codeCapability({ id: "search", name: "web_search" })]),
      }),
      query,
    );
    expect(keyed(tools, "capability:acme/search")?.enabled).toBe(true);
    expect(keyed(tools, "default:web-search")?.enabled).toBe(false);
    expect(keyed(tools, "default:web-search")?.shadowedBy).toBe("capability:acme/search");
  });

  it("exposes hand-wired workspace MCP servers as workspace-baseline tools", async () => {
    const tools = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({ mcpServers: [{ name: "internal", url: "https://mcp.acme.test", write: true }] }),
        ),
      }),
      query,
    );
    const entry = keyed(tools, "mcp:internal");
    expect(entry?.enabled).toBe(true);
    expect(entry?.writes).toBe(true);
  });

  it("keeps an adopted write capability read-only until the adoption opted in", async () => {
    const mcp: CapabilityRecord = {
      ...codeCapability({ id: "gh", name: "github" }),
      spec: { type: "mcp", url: "https://mcp.test", args: [], provides: [], requiredSecrets: [], write: true },
    };
    const withRef = async (enableWrite: boolean) =>
      resolveAgentCapabilities(
        deps({
          agentRegistry: fakeRegistry(
            agentSpec({
              capabilities: [{ source: TENANT, id: "gh", version: "1.0.0", secretBindings: {}, enableWrite }],
            }),
          ),
          capabilityStore: fakeCapabilities([mcp]),
        }),
        query,
      );
    expect(keyed(await withRef(false), "capability:acme/gh")?.writes).toBe(false);
    expect(keyed(await withRef(true), "capability:acme/gh")?.writes).toBe(true);
  });

  it("binds an own-workspace capability's secrets by name, and an adoption's by its explicit map", async () => {
    const withSecret: CapabilityRecord = {
      ...codeCapability({ id: "pager", name: "pager" }),
      spec: {
        type: "code",
        language: "python",
        code: "print(1)",
        parametersSchema: {},
        isReadOnly: true,
        requiredSecrets: [{ name: "API_KEY", description: "" }],
        examples: [],
      },
    };
    const plain = await resolveAgentCapabilities(deps({ capabilityStore: fakeCapabilities([withSecret]) }), query);
    expect(keyed(plain, "capability:acme/pager")?.secretBindings).toEqual({ API_KEY: "API_KEY" });
    const adopted = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({
            capabilities: [
              {
                source: TENANT,
                id: "pager",
                version: "1.0.0",
                secretBindings: { API_KEY: "MY_KEY" },
                enableWrite: false,
              },
            ],
          }),
        ),
        capabilityStore: fakeCapabilities([withSecret]),
      }),
      query,
    );
    expect(keyed(adopted, "capability:acme/pager")?.secretBindings).toEqual({ API_KEY: "MY_KEY" });
  });

  it("degrades to the workspace baseline when the personal overlay cannot be read", async () => {
    const failing: AgentMemberPreferenceStore = {
      get: async () => {
        throw new Error("db down");
      },
      setEntry: async () => {
        throw new Error("db down");
      },
      setModel: async () => {
        throw new Error("db down");
      },
    };
    const tools = await resolveAgentCapabilities(deps({ preferences: failing }), query);
    expect(keyed(tools, "default:web-search")?.enabled).toBe(true);
  });

  it("keeps skill capabilities out of the TOOL list (they belong to the skill library)", async () => {
    const skill: CapabilityRecord = {
      ...codeCapability({ id: "runbook", name: "runbook" }),
      spec: { type: "skill", instructions: "do the thing", files: [] },
    };
    const tools = await resolveAgentCapabilities(deps({ capabilityStore: fakeCapabilities([skill]) }), query);
    expect(keyed(tools, "capability:acme/runbook")).toBeUndefined();
  });
  // --- the skills channel: same overlay, over "what procedures this workspace supports" ---

  it("puts the workspace's authored skills on every member's agent by default", async () => {
    const resolution = await resolveAgentCapabilities(
      deps({ skillStore: fakeSkills([skillRecord({ id: "triage", name: "triage" })]) }),
      query,
    );
    expect(skillKeyed(resolution, "skill:triage")).toMatchObject({ enabled: true, baseline: true, scope: "workspace" });
  });

  it("lets a member drop a workspace skill their agent should not follow", async () => {
    const resolution = await resolveAgentCapabilities(
      deps({
        skillStore: fakeSkills([skillRecord({ id: "triage", name: "triage" })]),
        preferences: fakePreferences({}, { "skill:triage": false }),
      }),
      query,
    );
    expect(skillKeyed(resolution, "skill:triage")?.enabled).toBe(false);
  });

  it("scopes the caller's own private draft as personal", async () => {
    const resolution = await resolveAgentCapabilities(
      deps({ skillStore: fakeSkills([skillRecord({ id: "draft", name: "draft", visibility: "private" })]) }),
      query,
    );
    expect(skillKeyed(resolution, "skill:draft")?.scope).toBe("personal");
  });

  it("does NOT put a skill-kind publication in the library — the store is a place to copy FROM", async () => {
    // Publishing a skill hands other workspaces something to take a copy of (SkillService.importFromStore). It must
    // not also appear as a second, uneditable entry in anyone's library — including the publisher's own, where the
    // SkillRecord it was published from already lives.
    const pkg: CapabilityRecord = {
      ...codeCapability({ id: "runbook", name: "runbook" }),
      spec: { type: "skill", instructions: "do the thing", files: [] },
    };
    const published = await resolveAgentCapabilities(deps({ capabilityStore: fakeCapabilities([pkg]) }), query);
    expect(published.skills).toEqual([]);

    // Not even an old adoption pin can attach one: those resolve as TOOLS, and a skill is not a tool.
    const adopted = await resolveAgentCapabilities(
      deps({
        agentRegistry: fakeRegistry(
          agentSpec({
            capabilities: [{ source: TENANT, id: "runbook", version: "1.0.0", secretBindings: {}, enableWrite: false }],
          }),
        ),
        capabilityStore: fakeCapabilities([pkg]),
      }),
      query,
    );
    expect(adopted.skills).toEqual([]);
    expect(adopted.tools.some((t) => t.key === "capability:acme/runbook")).toBe(false);
  });

  it("lists every skill the agent follows as an owned, editable record — one channel, no packages", async () => {
    const resolution = await resolveAgentCapabilities(
      deps({ skillStore: fakeSkills([skillRecord({ id: "triage", name: "triage" })]) }),
      query,
    );
    expect(resolution.skills.map((s) => s.origin.channel)).toEqual(["authored"]);
    expect(skillKeyed(resolution, "skill:triage")?.version).toBe("1.0.0"); // the last content the workspace stamped
  });

  it("gives two members of one workspace different skill sets", async () => {
    const shared = { skillStore: fakeSkills([skillRecord({ id: "triage", name: "triage" })]) };
    const alice = await resolveAgentCapabilities(deps({ ...shared, preferences: fakePreferences({}, {}) }), query);
    const bob = await resolveAgentCapabilities(
      deps({ ...shared, preferences: fakePreferences({}, { "skill:triage": false }) }),
      { ...query, subject: "bob" },
    );
    expect(skillKeyed(alice, "skill:triage")?.enabled).toBe(true);
    expect(skillKeyed(bob, "skill:triage")?.enabled).toBe(false);
  });
});
