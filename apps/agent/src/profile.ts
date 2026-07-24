import type { SkillEntry } from "@everdict/agent-runtime";
import type { AgentRegistry, CapabilityStore, SecretStore, SkillStore } from "@everdict/application-control";
import type { CapabilityRecord } from "@everdict/contracts";
import { canConsumeCapability } from "@everdict/domain";
import type { ResolvedCodeTool } from "./code-tools.js";
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
  // Adopted code capabilities (type:'code') resolved to a runnable form — bridged as native `code__<name>` tools. The
  // ToolProvider decides which can safely run (own-workspace code on a host driver; adopted-from-others only isolated).
  codeTools: ResolvedCodeTool[];
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
  capabilityStore: CapabilityStore;
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
        codeTools: [],
      };
    }

    // The consumer's secret tiers (workspace + personal) — the auth values for BOTH the raw mcpServers and adopted mcp
    // capabilities are resolved from here (verbatim `Authorization` header). Fetched once, only if either needs it.
    const scoped: Awaited<ReturnType<SecretStore["scopedEntries"]>> =
      spec.mcpServers.length > 0 || spec.capabilities.length > 0
        ? await opts.secretStore.scopedEntries(principal.workspace, principal.subject)
        : { workspace: {}, user: {} };
    const resolveSecret = (name: string | undefined): string | undefined =>
      name ? (scoped.workspace[name] ?? scoped.user[name]) : undefined;

    const mcpServers: ResolvedMcpServer[] = [];
    const codeTools: ResolvedCodeTool[] = [];
    for (const s of spec.mcpServers) {
      const authorization = resolveSecret(s.authSecret); // verbatim header value (e.g. "Bearer …") — same discipline as trace sources
      mcpServers.push({ name: s.name, url: s.url, ...(authorization ? { authorization } : {}), write: s.write });
    }

    // Adopted Store capabilities — immutable-version references resolved cross-tenant, with visibility re-checked at
    // load time (a revoked/unpublished capability degrades to skipped, never fails the turn). mcp → an MCP server
    // (reuse the bridge); skill → a `use_skill` entry (merged with the ambient library, deduped by name); `code`
    // capabilities are a later runtime adapter. See docs/architecture/capability-store.md.
    for (const ref of spec.capabilities) {
      let record: CapabilityRecord | undefined;
      try {
        record = await opts.capabilityStore.getVersion(ref.source, ref.id, ref.version);
      } catch {
        record = undefined;
      }
      if (!record) continue; // unresolvable pin → skip (best-effort)
      if (!canConsumeCapability(record, { tenant: principal.workspace, subject: principal.subject })) continue; // access revoked → skip
      const capSpec = record.spec;
      if (capSpec.type === "mcp") {
        // Convention: the first declared required secret is the server's `Authorization` value; the adopter maps its
        // NAME to one of their own workspace/personal secrets via ref.secretBindings.
        const authName = capSpec.requiredSecrets[0]?.name;
        const authorization = resolveSecret(authName ? ref.secretBindings[authName] : undefined);
        mcpServers.push({
          name: record.name,
          url: capSpec.url,
          ...(authorization ? { authorization } : {}),
          write: capSpec.write && ref.enableWrite, // adopter opt-in AND the server offers write tools
        });
      } else if (capSpec.type === "skill") {
        if (!skills.some((s) => s.name === record.name))
          skills.push({ name: record.name, description: record.description, instructions: capSpec.instructions });
      } else if (capSpec.type === "code") {
        // Bind each declared required secret to the adopter's own secret VALUE (the code reads it as an env var by
        // its logical name). sandbox = adopted from another workspace → the ToolProvider requires an isolated runtime.
        const env: Record<string, string> = {};
        for (const rs of capSpec.requiredSecrets) {
          const value = resolveSecret(ref.secretBindings[rs.name]);
          if (value !== undefined) env[rs.name] = value;
        }
        codeTools.push({
          name: record.name,
          description: record.description,
          language: capSpec.language,
          code: capSpec.code,
          parametersSchema: capSpec.parametersSchema,
          isReadOnly: capSpec.isReadOnly,
          env,
          ...(capSpec.timeoutSec !== undefined ? { timeoutSec: capSpec.timeoutSec } : {}),
          ...(capSpec.image !== undefined ? { image: capSpec.image } : {}),
          sandbox: ref.source !== principal.workspace,
        });
      }
    }
    const hasWriteTools = mcpServers.some((s) => s.write);
    return {
      systemPrompt: composeSystemPrompt(opts.baseSystemPrompt, spec.instructions, hasWriteTools, skills.length > 0),
      ...(spec.model ? { model: spec.model } : {}),
      mcpServers,
      skills,
      codeTools,
    };
  };
}

// Dev / no-DB fallback: always the base profile (no per-workspace customization without a registry + stores).
export function baseProfileResolver(baseSystemPrompt: string): ProfileResolver {
  return async () => ({ systemPrompt: baseSystemPrompt, mcpServers: [], skills: [], codeTools: [] });
}
