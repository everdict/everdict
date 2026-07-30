import {
  type AgentCapabilitiesDeps,
  type AgentMemberPreferenceStore,
  type CapabilityStore,
  type ResolvedAgentSkill,
  type ResolvedAgentTool,
  type SecretStore,
  type SkillStore,
  type WorkspaceSettingsStore,
  resolveAgentCapabilities,
} from "@everdict/application-control";
import {
  type AgentPreferenceChannel,
  type AgentSpec,
  BadRequestError,
  type CapabilityRecord,
  type CapabilityRef,
  NotFoundError,
} from "@everdict/contracts";
import type {
  AgentSkillEntry,
  AgentSkillListResponse,
  AgentToolDetailResponse,
  AgentToolEntry,
  AgentToolFunction,
  AgentToolListResponse,
  AgentToolProbeResponse,
  AgentToolSecret,
  AgentToolTransport,
} from "@everdict/contracts/wire";
import { codeBridgedName, configuredIntegrations, mcpBridgedName } from "@everdict/domain";
import type { AgentRegistry } from "@everdict/registry";
import type { McpProbeAuth, McpProbeResult } from "../../infrastructure/mcp/probe-mcp.js";
import type { AgentService } from "./agent-service.js";

// Settings › Agent › Tools and › Skills — the member's own view of the workspace assistant: what the workspace
// supports, and which of it their agent actually carries. The AgentSpec + the authored skill library are the shared
// baseline; each member layers their own on/off (AgentMemberPreferenceStore), so one workspace is not one agent.
// Authoring/publishing/discovery is NOT here — that is the Skills editor and the Capability Store. These two surfaces
// are a list and a switch.

// The workspace's chat agent — the same config id the agent service resolves a conversation with (apps/agent
// AGENT_CONFIG_ID). Its spec is the baseline every member's overlay sits on.
export const AGENT_CHAT_CONFIG_ID = "default";

export interface AgentMemberToolingDeps {
  agents: AgentRegistry;
  capabilities: CapabilityStore;
  preferences: AgentMemberPreferenceStore;
  // The workspace's skill library (authored here or copied from a store example). Absent ⇒ no skills are listed:
  // there is no second channel a skill can arrive through.
  skills?: SkillStore;
  // Secret names the member can reach (workspace + their own personal tier) — turns a tool's declared secrets into
  // the "you still need X" gap the page shows. Absent ⇒ no gap is reported (never a false "missing").
  secrets?: SecretStore;
  // Which integrations the workspace configured — gates the integration-dependent first-party defaults.
  settings?: WorkspaceSettingsStore;
  // The AgentSpec upsert (same domain, the sibling service that owns agent-config writes). Rebinding a tool's secret
  // IS an AgentSpec edit — the binding lives on the adopted CapabilityRef / the hand-wired server — so it goes through
  // the same auto-versioning save the agent editor uses. Absent ⇒ binding is unavailable.
  agentService?: AgentService;
  // Live MCP connect (infrastructure/mcp) — turns "what functions does this tool have" from a declared list into the
  // server's real answer. Absent ⇒ probing is unavailable.
  probeMcp?: (url: string, auth?: McpProbeAuth) => Promise<McpProbeResult>;
}

export class AgentMemberToolingService {
  constructor(private readonly deps: AgentMemberToolingDeps) {}

  private resolverDeps(): AgentCapabilitiesDeps {
    return {
      agentRegistry: this.deps.agents,
      capabilityStore: this.deps.capabilities,
      preferences: this.deps.preferences,
      ...(this.deps.skills ? { skillStore: this.deps.skills } : {}),
      ...(this.deps.settings
        ? {
            integrationsConfigured: async (workspace: string) =>
              configuredIntegrations(await this.deps.settings?.get(workspace)),
          }
        : {}),
    };
  }

  private resolve(tenant: string, subject: string) {
    return resolveAgentCapabilities(this.resolverDeps(), { tenant, subject, agentId: AGENT_CHAT_CONFIG_ID });
  }

  // Every tool this member may put on their agent, with the effective on/off for them. Read-only.
  async listTools(tenant: string, subject: string): Promise<AgentToolListResponse> {
    const { tools } = await this.resolve(tenant, subject);
    const reachable = await this.reachableSecretNames(tenant, subject);
    return { tools: tools.map((tool) => toToolEntry(tool, reachable)) };
  }

  // ONE tool, in full — what it is, not just whether it is on. The list is the switch; this is the explanation the
  // member reads before trusting it: how it is reached, which functions it puts in front of the model, what the model
  // reads as its description, which secrets it needs and whether THEY can satisfy them.
  async getTool(tenant: string, subject: string, key: string): Promise<AgentToolDetailResponse> {
    const tool = await this.requireTool(tenant, subject, key);
    return toToolDetail(tool, await this.reachableSecretNames(tenant, subject), tenant);
  }

  // Connect to an HTTP MCP tool AS THIS MEMBER (their own bound secret) and list what it really serves. The declared
  // `provides` is the author's word; this is the server's. A failure is a RESULT (reachable:false + reason) — being
  // told "unreachable for me" is the answer the member came for.
  async probeTool(tenant: string, subject: string, key: string): Promise<AgentToolProbeResponse> {
    const probe = this.deps.probeMcp;
    if (!probe) throw new BadRequestError("BAD_REQUEST", { key }, "MCP probing is not configured on this deployment.");
    const tool = await this.requireTool(tenant, subject, key);
    const target = httpProbeTarget(tool);
    if (!target)
      throw new BadRequestError(
        "BAD_REQUEST",
        { key },
        "Only a remote (HTTP) MCP tool can be probed from here — a container tool is started by the agent, and a code tool is verified by running it.",
      );
    const values = await this.secretValues(tenant, subject);
    const missingSecrets: string[] = [];
    for (const [logical, bound] of Object.entries(tool.secretBindings))
      if (values !== undefined && values[bound] === undefined) missingSecrets.push(logical);
    const authorization = target.authSecret === undefined ? undefined : values?.[target.authSecret];
    const result = await probe(target.url, authorization ? { authorization } : {});
    return {
      reachable: result.reachable,
      detail: result.detail,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      functions: result.tools.map((t) => ({
        name: t.name,
        bridgedName: mcpBridgedName(target.serverName, t.name),
        description: t.description ?? "",
        ...(t.inputSchema !== undefined ? { parametersSchema: t.inputSchema } : {}),
        readOnly: !tool.writes,
      })),
      missingSecrets,
    };
  }

  // Point one tool's declared secrets at real secret NAMES. The binding is workspace-level because that is where it
  // lives — an adopted capability keeps it on its CapabilityRef, a hand-wired server on its `authSecret` — so this
  // writes the AgentSpec through the sibling save (a new immutable version, `latest` moves). Only those two channels
  // are bindable: a first-party default and a published-but-unadopted capability read the secret by its DECLARED
  // name, so the fix there is a secret of that name, not a mapping.
  async bindToolSecrets(
    tenant: string,
    subject: string,
    key: string,
    bindings: Record<string, string>,
  ): Promise<AgentToolDetailResponse> {
    const agentService = this.deps.agentService;
    if (!agentService)
      throw new BadRequestError("BAD_REQUEST", { key }, "Agent configuration is not writable on this deployment.");
    const tool = await this.requireTool(tenant, subject, key);
    if (!isBindable(tool))
      throw new BadRequestError(
        "BAD_REQUEST",
        { key },
        "This tool reads its secrets by their declared name — create a secret with that name instead of mapping it.",
      );
    const declared = new Set(Object.keys(tool.secretBindings));
    for (const name of Object.keys(bindings))
      if (!declared.has(name))
        throw new BadRequestError("BAD_REQUEST", { name }, `this tool does not declare a secret named '${name}'.`);

    let spec: AgentSpec;
    try {
      spec = await this.deps.agents.get(tenant, AGENT_CHAT_CONFIG_ID, "latest");
    } catch {
      // Bindable means the binding already lives on this workspace's agent, so a missing spec is a real inconsistency.
      throw new NotFoundError("NOT_FOUND", { key }, "this workspace has no agent configuration to bind against.");
    }
    // The upsert takes everything but the coordinates it assigns itself (a changed spec becomes a new version).
    const { id: _id, version: _version, ...body } = applyBindings(spec, tool, bindings);
    await agentService.saveAgent(tenant, subject, AGENT_CHAT_CONFIG_ID, body);
    return this.getTool(tenant, subject, key);
  }

  // Every skill the workspace supports, with the effective on/off for this member. Read-only.
  async listSkills(tenant: string, subject: string): Promise<AgentSkillListResponse> {
    const { skills } = await this.resolve(tenant, subject);
    return { skills: skills.map(toSkillEntry) };
  }

  // One member's decision about one tool. `enabled: null` drops the override — back to following the workspace.
  // The key must be a tool this member can actually see (an unknown/foreign key is 404, not a stored orphan).
  async setTool(tenant: string, subject: string, key: string, enabled: boolean | null): Promise<AgentToolListResponse> {
    const { tools } = await this.resolve(tenant, subject);
    await this.record(tenant, subject, "tools", key, enabled, tools);
    return this.listTools(tenant, subject);
  }

  // The skill twin of setTool — same overlay, the other channel.
  async setSkill(
    tenant: string,
    subject: string,
    key: string,
    enabled: boolean | null,
  ): Promise<AgentSkillListResponse> {
    const { skills } = await this.resolve(tenant, subject);
    await this.record(tenant, subject, "skills", key, enabled, skills);
    return this.listSkills(tenant, subject);
  }

  private async record(
    tenant: string,
    subject: string,
    channel: AgentPreferenceChannel,
    key: string,
    enabled: boolean | null,
    known: ReadonlyArray<{ key: string }>,
  ): Promise<void> {
    if (!known.some((entry) => entry.key === key))
      throw new NotFoundError("NOT_FOUND", { key }, `no such ${channel} entry for this member: ${key}`);
    await this.deps.preferences.setEntry(tenant, subject, channel, key, enabled);
  }

  // Names the member can bind a tool's required secret to: the workspace tier plus their own personal one.
  private async reachableSecretNames(tenant: string, subject: string): Promise<Set<string> | undefined> {
    if (!this.deps.secrets) return undefined;
    try {
      return new Set((await this.deps.secrets.list(tenant, subject)).map((meta) => meta.name));
    } catch {
      return undefined; // the secret tier is an annotation, not the answer — never fail the listing over it
    }
  }

  // The member's decrypted secret VALUES (workspace ⊕ personal) — needed only where the tool is actually contacted
  // (probe), never for a listing. undefined ⇒ no secret tier, so nothing is reported missing.
  private async secretValues(tenant: string, subject: string): Promise<Record<string, string> | undefined> {
    if (!this.deps.secrets) return undefined;
    try {
      const scoped = await this.deps.secrets.scopedEntries(tenant, subject);
      return { ...scoped.user, ...scoped.workspace }; // workspace wins, exactly like the agent runtime resolves it
    } catch {
      return undefined;
    }
  }

  // The one tool this member can see under `key` — an unknown or foreign key is 404, never an existence leak.
  private async requireTool(tenant: string, subject: string, key: string): Promise<ResolvedAgentTool> {
    const { tools } = await this.resolve(tenant, subject);
    const tool = tools.find((candidate) => candidate.key === key);
    if (!tool) throw new NotFoundError("NOT_FOUND", { key }, `no such tool for this member: ${key}`);
    return tool;
  }
}

// The capability record behind a tool — present for every channel except the hand-wired MCP server, which has no
// store identity at all (it was typed into the agent config).
function recordOf(tool: ResolvedAgentTool): CapabilityRecord | undefined {
  if (tool.origin.channel === "builtin") return tool.origin.builtin.record;
  if (tool.origin.channel === "capability") return tool.origin.record;
  return undefined;
}

// Can this member REBIND the tool's secrets? Only where a binding has somewhere to live: an ADOPTED capability
// (baseline=true ⇒ a CapabilityRef pins it on the AgentSpec) or a hand-wired MCP server.
function isBindable(tool: ResolvedAgentTool): boolean {
  if (tool.origin.channel === "mcpServer") return true;
  return tool.origin.channel === "capability" && tool.baseline;
}

// What a live probe would connect to: the URL, the server NAME the runtime namespaces its functions under, and the
// secret whose value becomes the Authorization header. undefined ⇒ not an HTTP MCP tool (nothing to probe).
function httpProbeTarget(
  tool: ResolvedAgentTool,
): { url: string; serverName: string; authSecret?: string } | undefined {
  if (tool.origin.channel === "mcpServer") {
    const server = tool.origin.server;
    return {
      url: server.url,
      serverName: server.name,
      ...(server.authSecret !== undefined ? { authSecret: server.authSecret } : {}),
    };
  }
  const record = recordOf(tool);
  if (!record || record.spec.type !== "mcp" || record.spec.image !== undefined || record.spec.url === undefined)
    return undefined;
  // The runtime sends the FIRST declared secret's value as the verbatim Authorization header (profile.shapeTool).
  const authName = record.spec.requiredSecrets[0]?.name;
  const bound = authName === undefined ? undefined : tool.secretBindings[authName];
  return { url: record.spec.url, serverName: record.name, ...(bound !== undefined ? { authSecret: bound } : {}) };
}

// The AgentSpec with this tool's bindings replaced. Two shapes, because the two bindable channels store it in two
// places: a hand-wired server's single `Authorization` becomes its `authSecret`; an adopted capability's map becomes
// its CapabilityRef.secretBindings. Everything else on the spec is carried through untouched.
function applyBindings(spec: AgentSpec, tool: ResolvedAgentTool, bindings: Record<string, string>): AgentSpec {
  if (tool.origin.channel === "mcpServer") {
    const serverName = tool.origin.server.name;
    const authSecret = bindings.Authorization?.trim() ?? "";
    return {
      ...spec,
      mcpServers: spec.mcpServers.map((server) => {
        if (server.name !== serverName) return server;
        // An empty name CLEARS the binding (the server goes back to unauthenticated), so drop the key entirely.
        const { authSecret: _current, ...rest } = server;
        return authSecret.length > 0 ? { ...rest, authSecret } : rest;
      }),
    };
  }
  const record = recordOf(tool);
  if (!record) return spec;
  const merged: Record<string, string> = {};
  for (const [logical, current] of Object.entries(tool.secretBindings)) {
    const next = bindings[logical]?.trim();
    merged[logical] = next && next.length > 0 ? next : current;
  }
  return {
    ...spec,
    capabilities: spec.capabilities.map((ref: CapabilityRef) =>
      ref.source === record.tenant && ref.id === record.id ? { ...ref, secretBindings: merged } : ref,
    ),
  };
}

// How the runtime reaches this tool — the three shapes are the three things the agent actually does.
function transportOf(tool: ResolvedAgentTool): AgentToolTransport {
  if (tool.origin.channel === "mcpServer") return { kind: "http", url: tool.origin.server.url };
  const spec = recordOf(tool)?.spec;
  if (spec?.type === "mcp")
    return spec.image !== undefined
      ? { kind: "stdio", image: spec.image, args: spec.args }
      : { kind: "http", url: spec.url ?? "" };
  if (spec?.type === "code")
    return {
      kind: "code",
      language: spec.language,
      ...(spec.timeoutSec !== undefined ? { timeoutSec: spec.timeoutSec } : {}),
      ...(spec.image !== undefined ? { image: spec.image } : {}),
    };
  // Only mcp/code specs ever become tools (the resolver drops the rest), so this is defensive, not reachable.
  return { kind: "http", url: "" };
}

// The functions this tool contributes to the model's tool list, as DECLARED. A code capability is exactly one (the
// tool IS the function, with its own JSON Schema); an mcp capability lists the names its author published; a
// hand-wired server declares nothing at all — for those two, a live probe is the real answer.
function declaredFunctions(tool: ResolvedAgentTool): AgentToolFunction[] {
  const record = recordOf(tool);
  if (!record) return [];
  const spec = record.spec;
  if (spec.type === "code")
    return [
      {
        name: record.name,
        bridgedName: codeBridgedName(record.name),
        description: record.description,
        ...(Object.keys(spec.parametersSchema).length > 0 ? { parametersSchema: spec.parametersSchema } : {}),
        readOnly: spec.isReadOnly,
      },
    ];
  if (spec.type !== "mcp") return [];
  return spec.provides.map((name) => ({
    name,
    bridgedName: mcpBridgedName(record.name, name),
    description: "",
    readOnly: !tool.writes,
  }));
}

// Each declared secret from THIS member's point of view: what the tool calls it, which secret name it actually reads,
// and whether that name exists in a tier they can reach. `reachable === undefined` (no secret tier wired) never
// reports a false gap — the same rule the listing's missingSecrets follows.
function secretsOf(tool: ResolvedAgentTool, reachable: Set<string> | undefined): AgentToolSecret[] {
  const spec = recordOf(tool)?.spec;
  const described = new Map<string, string>();
  if (spec?.type === "mcp" || spec?.type === "code")
    for (const rs of spec.requiredSecrets) described.set(rs.name, rs.description);
  return Object.entries(tool.secretBindings).map(([name, boundTo]) => ({
    name,
    description: described.get(name) ?? "",
    boundTo,
    resolved: reachable === undefined || reachable.has(boundTo),
  }));
}

// ResolvedAgentTool → the full detail row. Everything here is derived from what the resolver already decided; the
// only extra input is which secret names the member can reach.
function toToolDetail(
  tool: ResolvedAgentTool,
  reachable: Set<string> | undefined,
  tenant: string,
): AgentToolDetailResponse {
  const record = recordOf(tool);
  const spec = record?.spec;
  const codeSpec = spec?.type === "code" ? spec : undefined;
  return {
    ...toToolEntry(tool, reachable),
    origin: tool.origin.channel,
    transport: transportOf(tool),
    functions: declaredFunctions(tool),
    secrets: secretsOf(tool, reachable),
    ...(codeSpec ? { code: codeSpec.code, examples: codeSpec.examples } : { examples: [] }),
    ...(codeSpec && Object.keys(codeSpec.parametersSchema).length > 0
      ? { parametersSchema: codeSpec.parametersSchema }
      : {}),
    ...(record ? { capability: { source: record.tenant, id: record.id, version: record.version } } : {}),
    tags: record?.tags ?? [],
    bindable: isBindable(tool),
    // Editing + versioning a tool means editing the capability behind it — possible only for one this workspace owns
    // (a first-party default and another workspace's publication are read-only here).
    editable: tool.origin.channel === "capability" && record?.tenant === tenant,
    probeable: httpProbeTarget(tool) !== undefined,
  };
}

// ResolvedAgentTool → the wire row. The secret gap is computed here (the resolver stays storage-free).
function toToolEntry(tool: ResolvedAgentTool, reachable: Set<string> | undefined): AgentToolEntry {
  const requiredSecrets = Object.values(tool.secretBindings);
  return {
    key: tool.key,
    name: tool.name,
    description: tool.description,
    type: tool.type,
    scope: tool.scope,
    enabled: tool.enabled,
    baseline: tool.baseline,
    writes: tool.writes,
    requiredSecrets,
    missingSecrets: reachable ? requiredSecrets.filter((name) => !reachable.has(name)) : [],
    ...(tool.owner !== "" ? { source: tool.owner } : {}),
    ...(tool.version !== undefined ? { version: tool.version } : {}),
    ...(tool.shadowedBy !== undefined ? { shadowedBy: tool.shadowedBy } : {}),
  };
}

function toSkillEntry(skill: ResolvedAgentSkill): AgentSkillEntry {
  return {
    key: skill.key,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    enabled: skill.enabled,
    baseline: skill.baseline,
    ...(skill.version !== undefined ? { version: skill.version } : {}),
    ...(skill.shadowedBy !== undefined ? { shadowedBy: skill.shadowedBy } : {}),
  };
}
