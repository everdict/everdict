import type { SkillEntry } from "@everdict/agent-runtime";
import {
  type AgentRegistry,
  type CapabilityStore,
  type SecretStore,
  type SkillStore,
  firstPartyDefaults,
} from "@everdict/application-control";
import type { CapabilityRecord, CapabilityRequirement } from "@everdict/contracts";
import { canConsumeCapability, selectDefaultCapabilities } from "@everdict/domain";
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
        "to load its steps and follow them; load any supporting file it lists via `read_skill_file` only at the step " +
        "that needs it. Otherwise proceed normally.",
    );
  }
  return parts.join("\n\n");
}

// Merge the FIRST-PARTY default toolset into the resolved tools. A default is offered only when the workspace hasn't
// opted it out (by id), its tool name isn't already taken (adopted/authored tools SHADOW a default), and — for an
// integration-gated default — that integration is configured (the pure gate in @everdict/domain). First-party code is
// Everdict-authored → trusted, so it runs on any driver (sandbox:false, unlike adopted-from-others code). A default
// that declares required secrets none of which resolve is dropped — a built-in tool is never offered broken. Mutates
// `acc` in place. See docs/architecture/capability-store.md ("First-party default toolset").
function applyFirstPartyDefaults(
  acc: { mcpServers: ResolvedMcpServer[]; skills: SkillEntry[]; codeTools: ResolvedCodeTool[] },
  disabledDefaults: readonly string[],
  integrationsConfigured: readonly CapabilityRequirement[],
  resolveDefaultSecret: (name: string) => string | undefined,
): void {
  const takenNames = [
    ...acc.mcpServers.map((m) => m.name),
    ...acc.skills.map((s) => s.name),
    ...acc.codeTools.map((c) => c.name),
  ];
  const candidates = firstPartyDefaults().map((d) => ({
    id: d.record.id,
    name: d.record.name,
    requires: d.requires,
    def: d,
  }));
  for (const { def } of selectDefaultCapabilities(candidates, {
    integrationsConfigured,
    disabledDefaults,
    takenNames,
  })) {
    const spec = def.record.spec;
    if (spec.type === "code") {
      const env: Record<string, string> = {};
      for (const rs of spec.requiredSecrets) {
        const value = resolveDefaultSecret(rs.name);
        if (value !== undefined) env[rs.name] = value;
      }
      if (spec.requiredSecrets.length > 0 && Object.keys(env).length === 0) continue; // unconfigured → not offered
      acc.codeTools.push({
        name: def.record.name,
        description: def.record.description,
        language: spec.language,
        code: spec.code,
        parametersSchema: spec.parametersSchema,
        isReadOnly: spec.isReadOnly,
        env,
        ...(spec.timeoutSec !== undefined ? { timeoutSec: spec.timeoutSec } : {}),
        ...(spec.image !== undefined ? { image: spec.image } : {}),
        sandbox: false, // first-party = trusted → runs on any runtime, including the host LocalDriver
      });
    } else if (spec.type === "mcp") {
      if (!spec.url) continue; // first-party mcp DEFAULTS are HTTP-url only (image/stdio servers are catalog-adopt, never defaults)
      const authName = spec.requiredSecrets[0]?.name;
      const authorization = authName ? resolveDefaultSecret(authName) : undefined;
      if (spec.requiredSecrets.length > 0 && authorization === undefined) continue; // unconfigured → not offered
      acc.mcpServers.push({
        kind: "http",
        name: def.record.name,
        url: spec.url,
        ...(authorization ? { authorization } : {}),
        write: spec.write,
      });
    } else if (spec.type === "skill" && !acc.skills.some((s) => s.name === def.record.name)) {
      acc.skills.push({
        name: def.record.name,
        description: def.record.description,
        instructions: spec.instructions,
        files: spec.files,
      });
    }
  }
}

// D-plugin: the agent runs with the workspace's registered agent configuration. Resolve (workspace, configId) →
// AgentSpec; append its instructions to the base prompt, resolve each MCP server's authSecret to a verbatim
// Authorization value from the workspace/personal secret tiers, and surface its model override. On top of that, the
// FIRST-PARTY default toolset (web search, …) is merged in whether or not a workspace registered an AgentSpec — a
// workspace with no custom agent still gets the built-in tools. Best-effort throughout: any lookup failure degrades
// (fewer tools) rather than failing the turn.
export function registryProfileResolver(opts: {
  agentRegistry: AgentRegistry;
  secretStore: SecretStore;
  skillStore: SkillStore;
  capabilityStore: CapabilityStore;
  baseSystemPrompt: string;
  configId: string;
  // Operator-provided values for first-party DEFAULT tools, keyed by the secret name the default declares (e.g. the
  // web-search API key). Checked BEFORE the workspace's own secrets when resolving a default's requiredSecrets.
  defaultToolSecrets?: Record<string, string>;
  // Which integrations the workspace has configured — gates the integration-dependent defaults. Best-effort; unset or
  // a failure ⇒ no integration defaults (the unconditional ones still apply). Wired in the integration-adapter phase.
  integrationsConfigured?: (workspace: string) => Promise<readonly CapabilityRequirement[]>;
}): ProfileResolver {
  return async (principal) => {
    // Skills load independently of the AgentSpec — a workspace can have a skill library without a registered agent
    // config. The caller sees the workspace-shared skills + their own private drafts. Best-effort.
    let skills: SkillEntry[] = [];
    try {
      const records = await opts.skillStore.list(principal.workspace, principal.subject);
      skills = records.map((s) => ({
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        files: s.files,
      }));
    } catch {
      skills = [];
    }

    // The consumer's secret tiers (workspace + personal) — the auth for raw mcpServers, adopted capabilities, AND the
    // first-party defaults resolves from here. Fetched once, best-effort (a failure degrades to no secrets).
    let scoped: Awaited<ReturnType<SecretStore["scopedEntries"]>> = { workspace: {}, user: {} };
    try {
      scoped = await opts.secretStore.scopedEntries(principal.workspace, principal.subject);
    } catch {
      scoped = { workspace: {}, user: {} };
    }
    const resolveSecret = (name: string | undefined): string | undefined =>
      name ? (scoped.workspace[name] ?? scoped.user[name]) : undefined;
    // A default tool's secret: the operator-global value first, else the workspace's own secret of that name.
    const resolveDefaultSecret = (name: string): string | undefined =>
      opts.defaultToolSecrets?.[name] ?? resolveSecret(name);

    // Which integrations the workspace has configured — gates the integration-dependent defaults. Best-effort.
    let integrationsConfigured: readonly CapabilityRequirement[] = [];
    try {
      integrationsConfigured = (await opts.integrationsConfigured?.(principal.workspace)) ?? [];
    } catch {
      integrationsConfigured = [];
    }

    let spec: Awaited<ReturnType<AgentRegistry["get"]>> | undefined;
    try {
      spec = await opts.agentRegistry.get(principal.workspace, opts.configId, "latest");
    } catch {
      spec = undefined; // no workspace agent registered (or lookup failed) → base persona + skills + defaults only
    }

    const mcpServers: ResolvedMcpServer[] = [];
    const codeTools: ResolvedCodeTool[] = [];
    if (spec) {
      for (const s of spec.mcpServers) {
        const authorization = resolveSecret(s.authSecret); // verbatim header value (e.g. "Bearer …") — same discipline as trace sources
        // The raw escape hatch is HTTP-only (stdio is reachable via the curated capability path below).
        mcpServers.push({
          kind: "http",
          name: s.name,
          url: s.url,
          ...(authorization ? { authorization } : {}),
          write: s.write,
        });
      }

      // Adopted Store capabilities — immutable-version references resolved cross-tenant, with visibility re-checked at
      // load time (a revoked/unpublished capability degrades to skipped). mcp → an MCP server (reuse the bridge);
      // skill → a `use_skill` entry (merged with the ambient library, deduped by name); code → a native tool.
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
          const write = capSpec.write && ref.enableWrite; // adopter opt-in AND the server offers write tools
          if (capSpec.image) {
            // Containerized stdio server: bind each required secret to the adopter's own secret VALUE → a container
            // env var. Skip if a required secret is unbound (unconfigured → not offered, mirroring the code-tool path).
            const env: Record<string, string> = {};
            let unbound = false;
            for (const rs of capSpec.requiredSecrets) {
              const value = resolveSecret(ref.secretBindings[rs.name]);
              if (value === undefined) {
                unbound = true;
                break;
              }
              env[rs.name] = value;
            }
            if (unbound) continue;
            mcpServers.push({ kind: "stdio", name: record.name, image: capSpec.image, args: capSpec.args, env, write });
          } else if (capSpec.url) {
            // Remote HTTP server: the first declared required secret is the `Authorization` value; the adopter maps
            // its NAME to one of their own workspace/personal secrets via ref.secretBindings.
            const authName = capSpec.requiredSecrets[0]?.name;
            const authorization = resolveSecret(authName ? ref.secretBindings[authName] : undefined);
            mcpServers.push({
              kind: "http",
              name: record.name,
              url: capSpec.url,
              ...(authorization ? { authorization } : {}),
              write,
            });
          }
          // neither image nor url → an invalid mcp spec (rejected at the save boundary); skip defensively.
        } else if (capSpec.type === "skill") {
          if (!skills.some((s) => s.name === record.name))
            skills.push({
              name: record.name,
              description: record.description,
              instructions: capSpec.instructions,
              files: capSpec.files,
            });
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
    }

    // First-party DEFAULT toolset — merged AFTER adopted/authored tools so a same-named adopted tool shadows a default.
    applyFirstPartyDefaults(
      { mcpServers, skills, codeTools },
      spec?.disabledDefaults ?? [],
      integrationsConfigured,
      resolveDefaultSecret,
    );

    const hasWriteTools = mcpServers.some((s) => s.write);
    return {
      systemPrompt: composeSystemPrompt(opts.baseSystemPrompt, spec?.instructions, hasWriteTools, skills.length > 0),
      ...(spec?.model ? { model: spec.model } : {}),
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
