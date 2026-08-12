import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { AgentSpec, CapabilityRecord, SkillRecord } from "@everdict/contracts";
import type { AgentSkillEntry, AgentToolDetailResponse, AgentToolEntry } from "@everdict/contracts/wire";
import {
  InMemoryAgentMemberPreferenceStore,
  InMemoryCapabilityStore,
  InMemoryRunStore,
  InMemorySecretStore,
  InMemorySkillStore,
  aesGcmCipher,
} from "@everdict/db";
import { InMemoryAgentRegistry, InMemoryModelRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { AgentMemberToolingService } from "../../core/agent/agent-member-tooling-service.js";
import { AgentService } from "../../core/agent/agent-service.js";
import type { McpProbeAuth, McpProbeResult } from "../../infrastructure/mcp/probe-mcp.js";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in agent tool tests");
  },
};

const codeCapability = (over: Partial<CapabilityRecord> & Pick<CapabilityRecord, "id" | "name">): CapabilityRecord => ({
  tenant: "acme",
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
  createdBy: "dev",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

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

async function build(
  opts: {
    wired?: boolean;
    spec?: AgentSpec;
    capabilities?: CapabilityRecord[];
    skills?: SkillRecord[];
    secrets?: Record<string, string>; // workspace-tier secret name → value
    probe?: (url: string, auth?: McpProbeAuth) => Promise<McpProbeResult>;
    models?: string[]; // registered model ids a member may pick as their default (absent = no registry wired)
  } = {},
) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  const agents = new InMemoryAgentRegistry();
  const capabilities = new InMemoryCapabilityStore();
  const skills = new InMemorySkillStore();
  const preferences = new InMemoryAgentMemberPreferenceStore();
  const secretStore = new InMemorySecretStore(aesGcmCipher(Buffer.alloc(32, 7)));
  const models = new InMemoryModelRegistry();
  for (const id of opts.models ?? [])
    await models.register("acme", { id, version: "1.0.0", provider: "anthropic", model: `${id}-underlying`, tags: [] });
  if (opts.spec) await agents.register("acme", opts.spec, "dev");
  for (const record of opts.capabilities ?? []) await capabilities.register(record);
  for (const record of opts.skills ?? []) await skills.create(record);
  for (const [name, value] of Object.entries(opts.secrets ?? {})) await secretStore.set("acme", name, value);
  const app = buildServer({
    service,
    ...(opts.wired === false
      ? {}
      : {
          agentMemberToolingService: new AgentMemberToolingService({
            agents,
            capabilities,
            preferences,
            skills,
            secrets: secretStore,
            agentService: new AgentService({ agents }),
            ...(opts.probe ? { probeMcp: opts.probe } : {}),
            ...(opts.models ? { models } : {}),
          }),
        }),
  });
  return { app, preferences, agents };
}

const H = { "x-everdict-tenant": "acme" };
const toolsOf = (body: unknown): AgentToolEntry[] => (body as { tools: AgentToolEntry[] }).tools;
const find = (body: unknown, key: string): AgentToolEntry | undefined => toolsOf(body).find((t) => t.key === key);

describe("agent tool routes", () => {
  it("returns 404 when the agent tool service is not configured", async () => {
    const { app } = await build({ wired: false });
    const res = await app.inject({ method: "GET", url: "/agent/tools", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("lists the built-in defaults for a workspace that configured nothing", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/agent/tools", headers: H });
    expect(res.statusCode).toBe(200);
    const websearch = find(res.json(), "default:web-search");
    expect(websearch).toMatchObject({ scope: "builtin", enabled: true, baseline: true });
  });

  it("lists an authored workspace tool as available but off until the member switches it on", async () => {
    const { app } = await build({ capabilities: [codeCapability({ id: "draft", name: "draft" })] });
    const before = await app.inject({ method: "GET", url: "/agent/tools", headers: H });
    expect(find(before.json(), "capability:acme/draft")).toMatchObject({ enabled: false, baseline: false });

    const put = await app.inject({
      method: "PUT",
      url: "/agent/tools",
      headers: H,
      payload: { key: "capability:acme/draft", enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(find(put.json(), "capability:acme/draft")).toMatchObject({ enabled: true, baseline: false });
  });

  it("turning a workspace-baseline tool off is the member's own override, not a workspace change", async () => {
    const { app, preferences } = await build({
      spec: agentSpec({
        capabilities: [{ source: "acme", id: "jira", version: "1.0.0", secretBindings: {}, enableWrite: false }],
      }),
      capabilities: [codeCapability({ id: "jira", name: "jira" })],
    });
    const res = await app.inject({
      method: "PUT",
      url: "/agent/tools",
      headers: H,
      payload: { key: "capability:acme/jira", enabled: false },
    });
    expect(find(res.json(), "capability:acme/jira")).toMatchObject({ enabled: false, baseline: true });
    // The decision lives on the member, so another member still gets the workspace baseline.
    expect((await preferences.get("acme", "dev"))?.tools).toEqual({ "capability:acme/jira": false });
  });

  it("null clears the override so the member follows the workspace again", async () => {
    const { app, preferences } = await build();
    await app.inject({
      method: "PUT",
      url: "/agent/tools",
      headers: H,
      payload: { key: "default:web-search", enabled: false },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/agent/tools",
      headers: H,
      payload: { key: "default:web-search", enabled: null },
    });
    expect(find(cleared.json(), "default:web-search")?.enabled).toBe(true);
    expect((await preferences.get("acme", "dev"))?.tools).toEqual({});
  });

  it("rejects a tool key that is not in this member's toolset (404, no orphan stored)", async () => {
    const { app, preferences } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/agent/tools",
      headers: H,
      payload: { key: "capability:other/ghost", enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(await preferences.get("acme", "dev")).toBeUndefined();
  });

  it("rejects a malformed body (400)", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "PUT", url: "/agent/tools", headers: H, payload: { key: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("scopes the listing to the caller's workspace", async () => {
    const { app } = await build({ capabilities: [codeCapability({ id: "draft", name: "draft" })] });
    const other = await app.inject({ method: "GET", url: "/agent/tools", headers: { "x-everdict-tenant": "other" } });
    expect(find(other.json(), "capability:acme/draft")).toBeUndefined();
  });
});

describe("agent tool detail", () => {
  const mcpCapability = (over: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
    ...codeCapability({ id: "grafana", name: "grafana" }),
    spec: {
      type: "mcp",
      url: "https://mcp.grafana.test/mcp",
      args: [],
      provides: ["search_dashboards", "get_panel"],
      requiredSecrets: [{ name: "API_KEY", description: "Grafana service-account token" }],
      write: false,
    },
    ...over,
  });
  const adopted = (bindings: Record<string, string> = {}): AgentSpec =>
    agentSpec({
      capabilities: [{ source: "acme", id: "grafana", version: "1.0.0", secretBindings: bindings, enableWrite: false }],
    });
  const detail = (body: unknown): AgentToolDetailResponse => body as AgentToolDetailResponse;
  const key = encodeURIComponent("capability:acme/grafana");

  it("explains a built-in code tool: its transport, the function the model calls, and the secret it still needs", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/agent/tools/default%3Aweb-search", headers: H });
    expect(res.statusCode).toBe(200);
    const tool = detail(res.json());
    expect(tool).toMatchObject({ origin: "builtin", transport: { kind: "code", language: "node" } });
    // A code capability IS one function — and the model calls it by its NAMESPACED name, not the store name.
    expect(tool.functions).toHaveLength(1);
    expect(tool.functions[0]).toMatchObject({ name: "web_search", bridgedName: "code__web_search", readOnly: true });
    expect(tool.code).toContain("api.tavily.com");
    expect(tool.secrets).toEqual([
      expect.objectContaining({ name: "TAVILY_API_KEY", boundTo: "TAVILY_API_KEY", resolved: false }),
    ]);
    // A default belongs to Everdict, so its spec is not the member's to edit — but its secret binding lives on the
    // workspace agent's toolSecretBindings overlay, so it CAN be pointed at an existing secret.
    expect(tool).toMatchObject({ bindable: true, editable: false, probeable: false });
  });

  it("lists an mcp tool's declared functions under the names the runtime namespaces them with", async () => {
    const { app } = await build({ spec: adopted(), capabilities: [mcpCapability()] });
    const res = await app.inject({ method: "GET", url: `/agent/tools/${key}`, headers: H });
    const tool = detail(res.json());
    expect(tool.transport).toEqual({ kind: "http", url: "https://mcp.grafana.test/mcp" });
    expect(tool.functions.map((f) => f.bridgedName)).toEqual([
      "mcp__grafana__search_dashboards",
      "mcp__grafana__get_panel",
    ]);
    expect(tool).toMatchObject({ origin: "capability", bindable: true, editable: true, probeable: true });
  });

  it("reports a secret as resolved once the member holds one under the bound name", async () => {
    const { app } = await build({
      spec: adopted({ API_KEY: "GRAFANA_TOKEN" }),
      capabilities: [mcpCapability()],
      secrets: { GRAFANA_TOKEN: "Bearer abc" },
    });
    const res = await app.inject({ method: "GET", url: `/agent/tools/${key}`, headers: H });
    expect(detail(res.json()).secrets).toEqual([
      expect.objectContaining({ name: "API_KEY", boundTo: "GRAFANA_TOKEN", resolved: true }),
    ]);
  });

  it("a tool that is not in the caller's toolset is 404, not 403", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/agent/tools/capability%3Aother%2Fghost", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("binding a secret rewrites the adopted reference and cuts a new agent version", async () => {
    const { app, agents } = await build({ spec: adopted(), capabilities: [mcpCapability()] });
    const res = await app.inject({
      method: "PUT",
      url: `/agent/tools/${key}/secrets`,
      headers: H,
      payload: { bindings: { API_KEY: "GRAFANA_TOKEN" } },
    });
    expect(res.statusCode).toBe(200);
    expect(detail(res.json()).secrets[0]).toMatchObject({ boundTo: "GRAFANA_TOKEN" });
    const saved = await agents.get("acme", "default", "latest");
    expect(saved.version).toBe("1.0.1"); // the edit is a new immutable version, as every agent edit is
    expect(saved.capabilities[0]?.secretBindings).toEqual({ API_KEY: "GRAFANA_TOKEN" });
  });

  it("refuses to bind a name the tool never declared", async () => {
    const { app } = await build({ spec: adopted(), capabilities: [mcpCapability()] });
    const res = await app.inject({
      method: "PUT",
      url: `/agent/tools/${key}/secrets`,
      headers: H,
      payload: { bindings: { NOPE: "SOMETHING" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("binds a built-in default to an existing secret, bootstrapping the agent config when none exists", async () => {
    const { app, agents } = await build({ secrets: { MY_KEY: "tvly-abc" } });
    const res = await app.inject({
      method: "PUT",
      url: "/agent/tools/default%3Aweb-search/secrets",
      headers: H,
      payload: { bindings: { TAVILY_API_KEY: "MY_KEY" } },
    });
    expect(res.statusCode).toBe(200);
    // The remap is live in the refreshed detail — and the member's existing secret now satisfies it.
    expect(detail(res.json()).secrets).toEqual([
      expect.objectContaining({ name: "TAVILY_API_KEY", boundTo: "MY_KEY", resolved: true }),
    ]);
    // No spec existed, so the binding bootstrapped the chat config as its first version.
    const saved = await agents.get("acme", "default", "latest");
    expect(saved.version).toBe("1.0.0");
    expect(saved.toolSecretBindings).toEqual({ "default:web-search": { TAVILY_API_KEY: "MY_KEY" } });
  });

  it("binds an unadopted publication through the same overlay — no adopting reference required", async () => {
    const { app, agents } = await build({ capabilities: [mcpCapability()] });
    const res = await app.inject({
      method: "PUT",
      url: `/agent/tools/${key}/secrets`,
      headers: H,
      payload: { bindings: { API_KEY: "GRAFANA_TOKEN" } },
    });
    expect(res.statusCode).toBe(200);
    expect(detail(res.json()).secrets[0]).toMatchObject({ boundTo: "GRAFANA_TOKEN" });
    const saved = await agents.get("acme", "default", "latest");
    expect(saved.capabilities).toEqual([]); // still unadopted — the overlay carries the map, not a pin
    expect(saved.toolSecretBindings).toEqual({ "capability:acme/grafana": { API_KEY: "GRAFANA_TOKEN" } });
  });

  it("a blank name clears an overlay remap — the tool falls back to its declared name", async () => {
    const { app, agents } = await build();
    const bind = (name: string) =>
      app.inject({
        method: "PUT",
        url: "/agent/tools/default%3Aweb-search/secrets",
        headers: H,
        payload: { bindings: { TAVILY_API_KEY: name } },
      });
    await bind("MY_KEY");
    const res = await bind("");
    expect(res.statusCode).toBe(200);
    expect(detail(res.json()).secrets[0]).toMatchObject({ boundTo: "TAVILY_API_KEY" });
    const saved = await agents.get("acme", "default", "latest");
    expect(saved.toolSecretBindings).toEqual({}); // an emptied entry is dropped, not stored as {}
  });

  it("probing an mcp tool sends the member's own bound secret and returns what the server serves", async () => {
    let seen: McpProbeAuth | undefined;
    const { app } = await build({
      spec: adopted({ API_KEY: "GRAFANA_TOKEN" }),
      capabilities: [mcpCapability()],
      secrets: { GRAFANA_TOKEN: "Bearer abc" },
      probe: async (_url, auth) => {
        seen = auth;
        return { reachable: true, detail: "Connected — 1 tool available.", tools: [{ name: "search_dashboards" }] };
      },
    });
    const res = await app.inject({ method: "POST", url: `/agent/tools/${key}/probe`, headers: H });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ authorization: "Bearer abc" }); // verbatim, exactly as the agent runtime sends it
    expect(res.json()).toMatchObject({
      reachable: true,
      functions: [{ name: "search_dashboards", bridgedName: "mcp__grafana__search_dashboards" }],
      missingSecrets: [],
    });
  });

  it("an unreachable server is a probe RESULT, and the unresolved secret is named", async () => {
    const { app } = await build({
      spec: adopted(),
      capabilities: [mcpCapability()],
      probe: async () => ({ reachable: false, detail: "401 Unauthorized", reason: "auth", tools: [] }),
    });
    const res = await app.inject({ method: "POST", url: `/agent/tools/${key}/probe`, headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reachable: false, reason: "auth", missingSecrets: ["API_KEY"] });
  });

  it("refuses to probe a code tool — it is verified by running it, not by connecting", async () => {
    const { app } = await build({ probe: async () => ({ reachable: true, detail: "", tools: [] }) });
    const res = await app.inject({ method: "POST", url: "/agent/tools/default%3Aweb-search/probe", headers: H });
    expect(res.statusCode).toBe(400);
  });
});

describe("agent skill routes", () => {
  const skillRecord = (over: Partial<SkillRecord> & Pick<SkillRecord, "id" | "name">): SkillRecord => ({
    tenant: "acme",
    description: `${over.name} procedure`,
    instructions: "1. …",
    version: "1.0.0",
    files: [],
    refs: [],
    visibility: "workspace",
    createdBy: "dev",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  const skillsOf = (body: unknown): AgentSkillEntry[] => (body as { skills: AgentSkillEntry[] }).skills;
  const findSkill = (body: unknown, key: string): AgentSkillEntry | undefined =>
    skillsOf(body).find((s) => s.key === key);

  it("lists the workspace's authored skills as on for a member who configured nothing", async () => {
    const { app } = await build({ skills: [skillRecord({ id: "triage", name: "triage" })] });
    const res = await app.inject({ method: "GET", url: "/agent/skills", headers: H });
    expect(res.statusCode).toBe(200);
    expect(findSkill(res.json(), "skill:triage")).toMatchObject({
      enabled: true,
      baseline: true,
      scope: "workspace",
      version: "1.0.0",
    });
  });

  it("turning a workspace skill off is the member's own override, not a library change", async () => {
    const { app, preferences } = await build({ skills: [skillRecord({ id: "triage", name: "triage" })] });
    const res = await app.inject({
      method: "PUT",
      url: "/agent/skills",
      headers: H,
      payload: { key: "skill:triage", enabled: false },
    });
    expect(findSkill(res.json(), "skill:triage")).toMatchObject({ enabled: false, baseline: true });
    expect((await preferences.get("acme", "dev"))?.skills).toEqual({ "skill:triage": false });
    expect((await preferences.get("acme", "dev"))?.tools).toEqual({}); // the tool channel is untouched
  });

  it("null clears the skill override so the member follows the workspace again", async () => {
    const { app, preferences } = await build({ skills: [skillRecord({ id: "triage", name: "triage" })] });
    await app.inject({
      method: "PUT",
      url: "/agent/skills",
      headers: H,
      payload: { key: "skill:triage", enabled: false },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/agent/skills",
      headers: H,
      payload: { key: "skill:triage", enabled: null },
    });
    expect(findSkill(cleared.json(), "skill:triage")?.enabled).toBe(true);
    expect((await preferences.get("acme", "dev"))?.skills).toEqual({});
  });

  it("keeps a skill-kind publication OUT of the library — a store skill joins it by being copied in", async () => {
    // The library lists what the members own and can edit. A publication (theirs or another workspace's) is
    // something to take a copy of via POST /skills/import, not a row that shows up here uneditable.
    const pkg: CapabilityRecord = {
      ...codeCapability({ id: "runbook", name: "runbook" }),
      spec: { type: "skill", instructions: "do the thing", files: [] },
    };
    const { app } = await build({ capabilities: [pkg] });
    const res = await app.inject({ method: "GET", url: "/agent/skills", headers: H });
    expect(res.json().skills).toEqual([]);
  });

  it("rejects a skill key that is not in this member's library (404, no orphan stored)", async () => {
    const { app, preferences } = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/agent/skills",
      headers: H,
      payload: { key: "skill:ghost", enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(await preferences.get("acme", "dev")).toBeUndefined();
  });

  it("returns 404 when the service is not configured", async () => {
    const { app } = await build({ wired: false });
    expect((await app.inject({ method: "GET", url: "/agent/skills", headers: H })).statusCode).toBe(404);
  });
});

// The overlay's third channel — which model MY conversations think with. The workspace agent's model is one admin's
// answer for everybody; this is each member's own, and it is why a picker in the chat is not the only way to change it.
describe("agent model routes", () => {
  it("a member who picked nothing follows the workspace agent's model", async () => {
    const { app } = await build({ spec: agentSpec({ model: "team-llm" }), models: ["team-llm", "my-llm"] });
    const res = await app.inject({ method: "GET", url: "/agent/model", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ model: null, workspaceDefault: "team-llm" });
  });

  it("reports no baseline when the workspace registered no agent (the deployment default answers)", async () => {
    const { app } = await build({ models: ["my-llm"] });
    expect((await app.inject({ method: "GET", url: "/agent/model", headers: H })).json()).toEqual({
      model: null,
      workspaceDefault: null,
    });
  });

  it("records the member's own default model and keeps the workspace baseline visible beside it", async () => {
    const { app, preferences } = await build({
      spec: agentSpec({ model: "team-llm" }),
      models: ["team-llm", "my-llm"],
    });
    const res = await app.inject({ method: "PUT", url: "/agent/model", headers: H, payload: { model: "my-llm" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ model: "my-llm", workspaceDefault: "team-llm" });
    expect((await preferences.get("acme", "dev"))?.model).toBe("my-llm");
  });

  it("null clears the pick so the workspace baseline reaches the member again", async () => {
    const { app, preferences } = await build({ spec: agentSpec({ model: "team-llm" }), models: ["my-llm"] });
    await app.inject({ method: "PUT", url: "/agent/model", headers: H, payload: { model: "my-llm" } });
    const res = await app.inject({ method: "PUT", url: "/agent/model", headers: H, payload: { model: null } });
    expect(res.json()).toEqual({ model: null, workspaceDefault: "team-llm" });
    expect((await preferences.get("acme", "dev"))?.model).toBeNull();
  });

  it("refuses a model this workspace never registered (404, nothing stored)", async () => {
    // A stored id that resolves nowhere is a conversation that cannot answer — so the refusal belongs here.
    const { app, preferences } = await build({ models: ["my-llm"] });
    const res = await app.inject({ method: "PUT", url: "/agent/model", headers: H, payload: { model: "ghost" } });
    expect(res.statusCode).toBe(404);
    expect((await preferences.get("acme", "dev"))?.model ?? null).toBeNull();
  });

  it("rejects a body that is neither a model id nor null", async () => {
    const { app } = await build({ models: ["my-llm"] });
    const res = await app.inject({ method: "PUT", url: "/agent/model", headers: H, payload: { model: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("cannot pick a model on a deployment with no model registry (400), while reading still works", async () => {
    const { app } = await build({ spec: agentSpec({ model: "team-llm" }) });
    expect((await app.inject({ method: "GET", url: "/agent/model", headers: H })).statusCode).toBe(200);
    const res = await app.inject({ method: "PUT", url: "/agent/model", headers: H, payload: { model: "my-llm" } });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the service is not configured", async () => {
    const { app } = await build({ wired: false });
    expect((await app.inject({ method: "GET", url: "/agent/model", headers: H })).statusCode).toBe(404);
  });
});
