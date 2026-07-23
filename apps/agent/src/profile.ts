import type { AgentRegistry, SecretStore } from "@everdict/application-control";
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
}

export type ProfileResolver = (principal: Principal) => Promise<AgentProfile>;

// Compose the base persona with the workspace's own instructions (appended, so the persona + tool protocol stay
// fixed) and, when any workspace tool can mutate, a note that the built-in read-only stance no longer covers those.
function composeSystemPrompt(base: string, instructions: string | undefined, hasWriteTools: boolean): string {
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
  return parts.join("\n\n");
}

// D-plugin: the agent runs with the workspace's registered agent configuration. Resolve (workspace, configId) →
// AgentSpec; append its instructions to the base prompt, resolve each MCP server's authSecret to a verbatim
// Authorization value from the workspace/personal secret tiers, and surface its model override. No registered agent →
// the base profile (identical to the un-customized agent). Best-effort: a lookup failure degrades to the base profile.
export function registryProfileResolver(opts: {
  agentRegistry: AgentRegistry;
  secretStore: SecretStore;
  baseSystemPrompt: string;
  configId: string;
}): ProfileResolver {
  return async (principal) => {
    let spec: Awaited<ReturnType<AgentRegistry["get"]>> | undefined;
    try {
      spec = await opts.agentRegistry.get(principal.workspace, opts.configId, "latest");
    } catch {
      spec = undefined; // no workspace agent registered (or lookup failed) → base behavior
    }
    if (!spec) return { systemPrompt: opts.baseSystemPrompt, mcpServers: [] };

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
      systemPrompt: composeSystemPrompt(opts.baseSystemPrompt, spec.instructions, hasWriteTools),
      ...(spec.model ? { model: spec.model } : {}),
      mcpServers,
    };
  };
}

// Dev / no-DB fallback: always the base profile (no per-workspace customization without a registry + secret store).
export function baseProfileResolver(baseSystemPrompt: string): ProfileResolver {
  return async () => ({ systemPrompt: baseSystemPrompt, mcpServers: [] });
}
