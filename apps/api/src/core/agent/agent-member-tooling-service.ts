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
import { type AgentPreferenceChannel, NotFoundError } from "@everdict/contracts";
import type {
  AgentSkillEntry,
  AgentSkillListResponse,
  AgentToolEntry,
  AgentToolListResponse,
} from "@everdict/contracts/wire";
import { configuredIntegrations } from "@everdict/domain";
import type { AgentRegistry } from "@everdict/registry";

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
  // The workspace's authored skill library. Absent ⇒ only packaged skills (adopted / published / built-in) are listed.
  skills?: SkillStore;
  // Secret names the member can reach (workspace + their own personal tier) — turns a tool's declared secrets into
  // the "you still need X" gap the page shows. Absent ⇒ no gap is reported (never a false "missing").
  secrets?: SecretStore;
  // Which integrations the workspace configured — gates the integration-dependent first-party defaults.
  settings?: WorkspaceSettingsStore;
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
    origin: skill.origin.channel === "authored" ? "authored" : "packaged",
    scope: skill.scope,
    enabled: skill.enabled,
    baseline: skill.baseline,
    ...(skill.owner !== "" ? { source: skill.owner } : {}),
    ...(skill.version !== undefined ? { version: skill.version } : {}),
    ...(skill.shadowedBy !== undefined ? { shadowedBy: skill.shadowedBy } : {}),
  };
}
