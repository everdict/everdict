import type { SkillEntry, SubagentType } from "@everdict/agent-runtime";
import {
  type AgentCapabilitiesResolution,
  type AgentMemberPreferenceStore,
  type AgentRegistry,
  type CapabilityStore,
  type LatestVersionResolver,
  type ResolvedAgentSkill,
  type ResolvedAgentTool,
  type SecretStore,
  type SkillStore,
  resolveAgentCapabilities,
  resolveCoverage,
} from "@everdict/application-control";
import type { AgentSpec, CapabilityRequirement, SkillRecord } from "@everdict/contracts";
import type { ResolvedCodeTool } from "./code-tools.js";
import type { ResolvedMcpServer } from "./mcp-tools.js";
import type { Principal } from "./principal.js";

// The per-turn customization the workspace's AgentSpec resolves to: a system prompt (base + workspace instructions),
// an optional registered-model override, and the workspace's MCP tool servers with their auth secrets resolved. This
// is how a workspace plugs its own context + tools into the shared agent framework (Claude Code's CLAUDE.md + MCP,
// but per-workspace).
export interface AgentProfile {
  systemPrompt: string;
  // Registered model id override (else the agent server's default model). Two things can put one here, and the
  // narrower wins: THIS member's own default (Settings › Preferences) over the workspace agent's `AgentSpec.model`.
  // A crafted agent's declared model is not overridable this way — see the resolver.
  model?: string;
  mcpServers: ResolvedMcpServer[];
  // Workspace skills the caller can use (workspace-shared + their own private drafts) — surfaced as the `use_skill`
  // tool (Claude-Code-style progressive disclosure). Members author these; they're not imported.
  skills: SkillEntry[];
  // Adopted code capabilities (type:'code') resolved to a runnable form — bridged as native `code__<name>` tools. The
  // ToolProvider decides which can safely run (own-workspace code on a host driver; adopted-from-others only isolated).
  codeTools: ResolvedCodeTool[];
}

// agentId overrides which registered AgentSpec shapes the turn — a trigger activation runs with the CRAFTED
// agent's config (its instructions/tools/model ARE its identity), not the workspace's chat default
// (agent-automation A3). Unset → the resolver's configured default ("default", the chat config).
// `version` narrows a SAVED agent to one immutable version (default "latest") — the evolution loop's evaluate
// step needs it to try a candidate version that changed tools/model, not just the newest row. Meaningless
// without agentId; resolvers ignore it then.
export type ProfileResolver = (principal: Principal, agentId?: string, version?: string) => Promise<AgentProfile>;

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

// The member's enabled skills → the `use_skill` library. The DECISION (which skills this member's agent follows,
// including name shadowing) was already made by resolveAgentCapabilities; this only loads each one's body. Every
// entry is a SkillRecord the workspace owns — a store skill becomes one by being copied in — so coverage (current |
// behind | unverified) applies to all of them, in ONE batched pass. Best-effort: no resolver / a failed lookup means
// the listing simply carries no badge.
async function shapeSkills(
  enabled: readonly ResolvedAgentSkill[],
  workspace: string,
  latestVersionOf: LatestVersionResolver | undefined,
): Promise<SkillEntry[]> {
  const records: SkillRecord[] = enabled.map((skill) => skill.origin.record);
  let coverage: Awaited<ReturnType<typeof resolveCoverage>> | undefined;
  if (latestVersionOf && records.length > 0) {
    try {
      coverage = await resolveCoverage(workspace, records, latestVersionOf, new Date().toISOString());
    } catch {
      coverage = undefined;
    }
  }
  return records.map((record, i) => {
    const c = coverage?.[i];
    return {
      name: record.name,
      description: record.description,
      instructions: record.instructions,
      files: record.files,
      ...(c !== undefined ? { coverage: c } : {}),
    };
  });
}

// One resolved tool → the runnable form the agent bridges. The DECISION of what belongs in this member's toolset was
// already made (resolveAgentToolset); this only shapes what survived and binds its secrets:
//  · a first-party default resolves secrets from the operator-global values first, everything else from the member's
//    own workspace/personal tiers (through the binding map the resolver computed);
//  · a tool whose required secrets don't resolve is DROPPED for the transports that cannot run without them —
//    a stdio MCP container and a built-in are never offered broken;
//  · sandbox = the code came from another workspace (first-party is Everdict-authored → trusted on any driver).
// Mutates `acc` in place.
function shapeTool(
  tool: ResolvedAgentTool,
  acc: { mcpServers: ResolvedMcpServer[]; codeTools: ResolvedCodeTool[] },
  resolve: {
    secret: (name: string | undefined) => string | undefined;
    defaultSecret: (name: string) => string | undefined;
  },
  workspace: string,
): void {
  const origin = tool.origin;
  if (origin.channel === "mcpServer") {
    // The raw escape hatch is HTTP-only (stdio is reachable via the curated capability path).
    const server = origin.server;
    const authorization = resolve.secret(server.authSecret); // verbatim header value (e.g. "Bearer …")
    acc.mcpServers.push({
      kind: "http",
      name: server.name,
      url: server.url,
      ...(authorization ? { authorization } : {}),
      write: server.write,
    });
    return;
  }
  const builtin = origin.channel === "builtin";
  const record = origin.channel === "builtin" ? origin.builtin.record : origin.record;
  const spec = record.spec;
  // The member-side value of a secret the capability declares by its logical name.
  const secretValue = (logical: string): string | undefined => {
    const bound = tool.secretBindings[logical] ?? logical;
    return builtin ? resolve.defaultSecret(bound) : resolve.secret(bound);
  };

  if (spec.type === "mcp") {
    if (spec.image) {
      if (builtin) return; // first-party mcp DEFAULTS are HTTP-url only (image/stdio servers are catalog-adopt)
      // Containerized stdio server: each required secret becomes a container env var. An unbound one means the tool
      // cannot run at all, so it is not offered (mirroring the code path's "unconfigured → absent").
      const env: Record<string, string> = {};
      for (const rs of spec.requiredSecrets) {
        const value = secretValue(rs.name);
        if (value === undefined) return;
        env[rs.name] = value;
      }
      acc.mcpServers.push({
        kind: "stdio",
        name: record.name,
        image: spec.image,
        args: spec.args,
        env,
        write: tool.writes,
        // O4: the author's declared blast radius travels with the tool to the permission gate. Dropping it
        // here is what left the gate guessing from tool names while the declaration sat unread in the spec.
        ...(spec.effects ? { effects: spec.effects } : {}),
      });
      return;
    }
    if (!spec.url) return; // neither image nor url → an invalid mcp spec (rejected at the save boundary); skip defensively
    // Remote HTTP server: the first declared required secret is the `Authorization` value.
    const authName = spec.requiredSecrets[0]?.name;
    const authorization = authName ? secretValue(authName) : undefined;
    if (builtin && spec.requiredSecrets.length > 0 && authorization === undefined) return; // unconfigured → not offered
    acc.mcpServers.push({
      kind: "http",
      name: record.name,
      url: spec.url,
      ...(authorization ? { authorization } : {}),
      write: tool.writes,
      ...(spec.effects ? { effects: spec.effects } : {}),
    });
    return;
  }
  if (spec.type !== "code") return; // skills/environments are not bridged as tools
  const env: Record<string, string> = {};
  for (const rs of spec.requiredSecrets) {
    const value = secretValue(rs.name);
    if (value !== undefined) env[rs.name] = value;
  }
  if (builtin && spec.requiredSecrets.length > 0 && Object.keys(env).length === 0) return; // unconfigured → not offered
  acc.codeTools.push({
    name: record.name,
    description: record.description,
    language: spec.language,
    code: spec.code,
    parametersSchema: spec.parametersSchema,
    isReadOnly: spec.isReadOnly,
    env,
    ...(spec.timeoutSec !== undefined ? { timeoutSec: spec.timeoutSec } : {}),
    ...(spec.image !== undefined ? { image: spec.image } : {}),
    sandbox: !builtin && record.tenant !== workspace,
    examples: spec.examples,
    ...(spec.effects ? { effects: spec.effects } : {}),
  });
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
  // The caller's own decisions (Settings › Agent › Tools + › Skills). Absent ⇒ every member gets the workspace baseline.
  preferences?: AgentMemberPreferenceStore;
  baseSystemPrompt: string;
  configId: string;
  // Operator-provided values for first-party DEFAULT tools, keyed by the secret name the default declares (e.g. the
  // web-search API key). Checked BEFORE the workspace's own secrets when resolving a default's requiredSecrets.
  defaultToolSecrets?: Record<string, string>;
  // Which integrations the workspace has configured — gates the integration-dependent defaults. Best-effort; unset or
  // a failure ⇒ no integration defaults (the unconditional ones still apply). Wired in the integration-adapter phase.
  integrationsConfigured?: (workspace: string) => Promise<readonly CapabilityRequirement[]>;
  // Latest-version resolution over the registries — when present, each skill carries its subject-time coverage
  // (current | behind | unverified) that use_skill surfaces as a listing badge + as-of body banner. Best-effort.
  latestVersionOf?: LatestVersionResolver;
}): ProfileResolver {
  return async (principal, agentId, version) => {
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

    let spec: AgentSpec | undefined;
    try {
      // A version pin only makes sense against the agent the caller NAMED — the config fallback always floats.
      spec = await opts.agentRegistry.get(
        principal.workspace,
        agentId ?? opts.configId,
        agentId !== undefined && version !== undefined ? version : "latest",
      );
    } catch {
      spec = undefined; // no workspace agent registered (or lookup failed) → base persona + skills + defaults only
    }

    // THIS member's own default model (Settings › Preferences) — the third channel of the same overlay the tools and
    // skills come from, and the answer to "the workspace picked one model for everybody". It outranks the workspace
    // agent's AgentSpec.model because it is the narrower statement about whose conversation this is; the conversation's
    // own pick (session.model, applied by the caller) is narrower still.
    // NOT for a crafted agent: a registered agent's model IS part of its identity (a trigger activation runs the agent
    // that was declared, not the activating member's taste), so only the workspace CHAT agent consults the preference.
    let memberModel: string | undefined;
    const isChatAgent = agentId === undefined || agentId === opts.configId;
    if (opts.preferences && isChatAgent) {
      try {
        memberModel = (await opts.preferences.get(principal.workspace, principal.subject))?.model ?? undefined;
      } catch {
        memberModel = undefined; // best-effort, like every other lookup here: the workspace baseline still applies
      }
    }

    // THIS member's agent — not the workspace's. The AgentSpec + the authored skill library are the shared baseline
    // (hand-wired servers, adopted capabilities, default opt-outs, the team's skills); the caller's own overrides sit
    // on top, so the same assistant answers two members of one workspace with different tools AND different
    // procedures. Best-effort: a lookup failure degrades to fewer tools/skills, never to a failed turn.
    const mcpServers: ResolvedMcpServer[] = [];
    const codeTools: ResolvedCodeTool[] = [];
    let resolved: AgentCapabilitiesResolution = { tools: [], skills: [] };
    try {
      resolved = await resolveAgentCapabilities(
        {
          agentRegistry: opts.agentRegistry,
          capabilityStore: opts.capabilityStore,
          skillStore: opts.skillStore,
          ...(opts.preferences ? { preferences: opts.preferences } : {}),
          ...(opts.integrationsConfigured ? { integrationsConfigured: opts.integrationsConfigured } : {}),
        },
        {
          tenant: principal.workspace,
          subject: principal.subject,
          agentId: agentId ?? opts.configId,
          ...(spec ? { spec } : {}), // already loaded above for instructions/model — no second registry round-trip
        },
      );
    } catch {
      resolved = { tools: [], skills: [] };
    }
    for (const tool of resolved.tools) {
      if (!tool.enabled) continue;
      shapeTool(
        tool,
        { mcpServers, codeTools },
        { secret: resolveSecret, defaultSecret: resolveDefaultSecret },
        principal.workspace,
      );
    }

    const skills = await shapeSkills(
      resolved.skills.filter((s) => s.enabled),
      principal.workspace,
      opts.latestVersionOf,
    );

    const hasWriteTools = mcpServers.some((s) => s.write);
    const model = memberModel ?? spec?.model;
    return {
      systemPrompt: composeSystemPrompt(opts.baseSystemPrompt, spec?.instructions, hasWriteTools, skills.length > 0),
      ...(model ? { model } : {}),
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

// Registered (crafted) agents as spawnable sub-agent TYPES — Claude Code's `.claude/agents` registry
// reinterpreted over the workspace agent registry: each registered agent with instructions becomes a role the
// model can pick via spawn_agent(subagent_type). The instructions ARE the role prompt; the tools stay the
// kernel's read-only sub-agent surface (the isolation invariant — a delegated spawn researches/verifies, it does
// not run the crafted agent's full activation), and the model tier defers to the workspace's subagentModel (no
// per-type model resolution — that would resolve N providers per turn for roles that rarely run). The chat's own
// config agent is excluded: spawning yourself as your own sub-agent is noise, not delegation. Best-effort — an
// unreachable registry means no crafted types, never a failed turn.
export function registrySubagentTypes(
  agentRegistry: AgentRegistry,
  configId: string,
  maxTypes = 12,
): (principal: Principal) => Promise<SubagentType[]> {
  return async (principal) => {
    try {
      const listed = await agentRegistry.list(principal.workspace);
      const out: SubagentType[] = [];
      for (const { id } of listed) {
        if (id === configId) continue;
        if (out.length >= maxTypes) break; // keep the spawn tool's type listing bounded
        try {
          const spec = await agentRegistry.get(principal.workspace, id);
          if (!spec.instructions || spec.instructions.trim().length === 0) continue;
          out.push({
            name: spec.id,
            description:
              spec.description && spec.description.trim().length > 0
                ? spec.description
                : `the workspace's registered agent "${spec.id}"`,
            instructions: spec.instructions,
          });
        } catch {
          // a broken/tombstoned spec is skipped, never fatal
        }
      }
      return out;
    } catch {
      return [];
    }
  };
}
