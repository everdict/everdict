import type { SkillEntry } from "@everdict/agent-runtime";
import type { AgentRegistry, SecretStore, SkillStore } from "@everdict/application-control";
import type { ResolvedMcpServer } from "./mcp-tools.js";
import type { Principal } from "./principal.js";

// The per-turn customization the workspace's AgentSpec resolves to: a system prompt (base + workspace instructions),
// an optional registered-model override, and the workspace's MCP tool servers with their auth secrets resolved. This
// is how a workspace plugs its own context + tools into the shared agent framework (Claude Code's CLAUDE.md + MCP,
// but per-workspace).
export interface AgentProfile {
  systemPrompt: string;
  model?: string; // registered model id override (else the agent server's default model)
  mcpServers: ResolvedMcpServer[];
  // Workspace skills the caller can use (workspace-shared + their own private drafts) — surfaced as the `use_skill`
  // tool (Claude-Code-style progressive disclosure). Members author these; they're not imported.
  skills: SkillEntry[];
}

export type ProfileResolver = (principal: Principal) => Promise<AgentProfile>;

// Compose the base persona with the workspace's own instructions (appended, so the persona + tool protocol stay
// fixed), a note when any workspace tool can mutate, and a note when the workspace has authored skills.
function composeSystemPrompt(
  base: string,
  instructions: string | undefined,
  hasWriteTools: boolean,
  hasSkills: boolean,
): string {
  const parts = [base];
  if (instructions && instructions.trim().length > 0) {
    parts.push(`## Workspace instructions\n${instructions.trim()}`);
  }
  if (hasWriteTools) {
    parts.push(
      "## Workspace tools\nThis workspace has connected additional MCP tool servers. Some of their tools can make " +
        "changes (create/modify/delete), unlike the built-in Everdict tools which stay read-only. Use the mutating " +
        "tools deliberately and only when the member's intent is clear.",
    );
  }
  if (hasSkills) {
    parts.push(
      "## Workspace skills\nThis workspace has saved SKILLs — reusable procedures the members authored for recurring " +
        "tasks. The `use_skill` tool lists them (name + when-to-use). When a request matches a skill, call `use_skill` " +
        "to load its steps and follow them; otherwise proceed normally.",
    );
  }
  return parts.join("\n\n");
}

// D-plugin: the agent runs with the workspace's registered agent configuration. Resolve (workspace, configId) →
// AgentSpec; append its instructions to the base prompt, resolve each MCP server's authSecret to a verbatim
// Authorization value from the workspace/personal secret tiers, and surface its model override. No registered agent →
// the base profile (identical to the un-customized agent). Best-effort: a lookup failure degrades to the base profile.
export function registryProfileResolver(opts: {
  agentRegistry: AgentRegistry;
  secretStore: SecretStore;
  skillStore: SkillStore;
  baseSystemPrompt: string;
  configId: string;
}): ProfileResolver {
  return async (principal) => {
    // Skills load independently of the AgentSpec — a workspace can have a skill library without a registered agent
    // config. The caller sees the workspace-shared skills + their own private drafts. Best-effort: a lookup failure
    // degrades to no skills rather than failing the turn.
    let skills: SkillEntry[] = [];
    try {
      const records = await opts.skillStore.list(principal.workspace, principal.subject);
      skills = records.map((s) => ({ name: s.name, description: s.description, instructions: s.instructions }));
    } catch {
      skills = [];
    }

    let spec: Awaited<ReturnType<AgentRegistry["get"]>> | undefined;
    try {
      spec = await opts.agentRegistry.get(principal.workspace, opts.configId, "latest");
    } catch {
      spec = undefined; // no workspace agent registered (or lookup failed) → base persona + skills only
    }
    if (!spec) {
      return {
        systemPrompt: composeSystemPrompt(opts.baseSystemPrompt, undefined, false, skills.length > 0),
        mcpServers: [],
        skills,
      };
    }

    const mcpServers: ResolvedMcpServer[] = [];
    if (spec.mcpServers.length > 0) {
      const scoped = await opts.secretStore.scopedEntries(principal.workspace, principal.subject);
      for (const s of spec.mcpServers) {
        let authorization: string | undefined;
        if (s.authSecret) {
          const value = scoped.workspace[s.authSecret] ?? scoped.user[s.authSecret];
          if (value !== undefined) authorization = value; // verbatim header value (e.g. "Bearer …") — same discipline as trace sources
        }
        mcpServers.push({ name: s.name, url: s.url, ...(authorization ? { authorization } : {}), write: s.write });
      }
    }
    const hasWriteTools = mcpServers.some((s) => s.write);
    return {
      systemPrompt: composeSystemPrompt(opts.baseSystemPrompt, spec.instructions, hasWriteTools, skills.length > 0),
      ...(spec.model ? { model: spec.model } : {}),
      mcpServers,
      skills,
    };
  };
}

// Dev / no-DB fallback: always the base profile (no per-workspace customization without a registry + stores).
export function baseProfileResolver(baseSystemPrompt: string): ProfileResolver {
  return async () => ({ systemPrompt: baseSystemPrompt, mcpServers: [], skills: [] });
}
