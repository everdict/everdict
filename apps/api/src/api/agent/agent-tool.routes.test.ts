import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { AgentSpec, CapabilityRecord, SkillRecord } from "@everdict/contracts";
import type { AgentSkillEntry, AgentToolEntry } from "@everdict/contracts/wire";
import {
  InMemoryAgentMemberPreferenceStore,
  InMemoryCapabilityStore,
  InMemoryRunStore,
  InMemorySkillStore,
} from "@everdict/db";
import { InMemoryAgentRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { AgentMemberToolingService } from "../../core/agent/agent-member-tooling-service.js";
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
  triggers: [],
  enabled: false,
  tags: [],
  ...over,
});

async function build(
  opts: { wired?: boolean; spec?: AgentSpec; capabilities?: CapabilityRecord[]; skills?: SkillRecord[] } = {},
) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  const agents = new InMemoryAgentRegistry();
  const capabilities = new InMemoryCapabilityStore();
  const skills = new InMemorySkillStore();
  const preferences = new InMemoryAgentMemberPreferenceStore();
  if (opts.spec) await agents.register("acme", opts.spec, "dev");
  for (const record of opts.capabilities ?? []) await capabilities.register(record);
  for (const record of opts.skills ?? []) await skills.create(record);
  const app = buildServer({
    service,
    ...(opts.wired === false
      ? {}
      : { agentMemberToolingService: new AgentMemberToolingService({ agents, capabilities, preferences, skills }) }),
  });
  return { app, preferences };
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

describe("agent skill routes", () => {
  const skillRecord = (over: Partial<SkillRecord> & Pick<SkillRecord, "id" | "name">): SkillRecord => ({
    tenant: "acme",
    description: `${over.name} procedure`,
    instructions: "1. …",
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
      origin: "authored",
      scope: "workspace",
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

  it("offers a published skill package nobody adopted — off until the member switches it on", async () => {
    const pkg: CapabilityRecord = {
      ...codeCapability({ id: "runbook", name: "runbook" }),
      spec: { type: "skill", instructions: "do the thing", files: [] },
    };
    const { app } = await build({ capabilities: [pkg] });
    const before = await app.inject({ method: "GET", url: "/agent/skills", headers: H });
    expect(findSkill(before.json(), "capability:acme/runbook")).toMatchObject({
      enabled: false,
      baseline: false,
      origin: "packaged",
    });
    const put = await app.inject({
      method: "PUT",
      url: "/agent/skills",
      headers: H,
      payload: { key: "capability:acme/runbook", enabled: true },
    });
    expect(findSkill(put.json(), "capability:acme/runbook")?.enabled).toBe(true);
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
