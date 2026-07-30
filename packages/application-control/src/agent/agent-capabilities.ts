import type {
  AgentMcpServer,
  AgentSpec,
  AgentToolScope,
  CapabilityRecord,
  CapabilityRef,
  CapabilityRequirement,
  SkillRecord,
} from "@everdict/contracts";
import {
  authoredSkillKey,
  builtinToolKey,
  canConsumeCapability,
  capabilityToolKey,
  mcpServerToolKey,
  selectDefaultCapabilities,
  selectForMember,
} from "@everdict/domain";
import { type FirstPartyDefault, firstPartyDefaults } from "../capability/first-party.js";
import type { AgentMemberPreferenceStore } from "../ports/agent-member-preference-store.js";
import type { AgentRegistry } from "../ports/agent-registry.js";
import type { CapabilityStore } from "../ports/capability-store.js";
import type { SkillStore } from "../ports/skill-store.js";

// resolveAgentCapabilities — the ONE place that answers "what does this member's agent carry, right now": the TOOLS
// it can call and the SKILLS it follows. Both transports of that answer read it: apps/api renders it as
// Settings › Agent › Tools and › Skills (list + switch), and apps/agent turns it into the live toolset + use_skill
// library for the turn. Keeping it single-sourced is the point: the pages a member configures and the agent that
// answers them cannot disagree.
//
// The workspace is the shared BASELINE (adopted capabilities, hand-wired MCP servers, the authored skill library,
// first-party default opt-outs); the member's own overrides sit on top (@everdict/domain selectForMember). So one
// workspace no longer means one agent — see docs/architecture/capability-store.md.

// Where a tool came from, with everything the runtime needs to actually build it.
export type AgentToolOrigin =
  | { channel: "builtin"; builtin: FirstPartyDefault }
  | { channel: "capability"; record: CapabilityRecord }
  | { channel: "mcpServer"; server: AgentMcpServer };

export interface ResolvedAgentTool {
  key: string;
  name: string;
  description: string;
  type: "mcp" | "code";
  scope: AgentToolScope;
  enabled: boolean; // effective for THIS member
  baseline: boolean; // what the workspace put on the table (enabled !== baseline ⇒ the member overrode it)
  writes: boolean; // EFFECTIVE mutation flag (an mcp adopted without enableWrite bridges read verbs only)
  // logical secret name → the name of the secret THIS member must hold. An adopted capability maps them explicitly
  // (CapabilityRef.secretBindings); anything else binds by same-name convention.
  secretBindings: Record<string, string>;
  owner: string; // the workspace that published it (= the caller's tenant for own/private tools; "" for raw mcp servers)
  version?: string;
  shadowedBy?: string; // an enabled same-named tool already owns this name
  origin: AgentToolOrigin;
}

export interface AgentCapabilitiesDeps {
  agentRegistry: AgentRegistry;
  capabilityStore: CapabilityStore;
  // The workspace's skill library (authored here or copied from a store example). Absent ⇒ no skills resolve:
  // a skill reaches an agent only as a record this workspace owns.
  skillStore?: SkillStore;
  preferences?: AgentMemberPreferenceStore; // absent ⇒ everyone gets the workspace baseline (no personal layer)
  // Which integrations the workspace has configured — gates the integration-dependent first-party defaults.
  integrationsConfigured?: (workspace: string) => Promise<readonly CapabilityRequirement[]>;
}

export interface AgentCapabilitiesQuery {
  tenant: string;
  subject: string;
  agentId: string; // which registered AgentSpec is the baseline (the chat default, or a crafted agent)
  // The already-loaded baseline spec, when the caller has one (the agent runtime reads it for instructions/model on
  // the same turn). Passing it skips a second registry round-trip; omitting it makes this resolve it.
  spec?: AgentSpec;
}

// A capability's requiredSecrets → the member-side binding map. An adopted ref carries explicit bindings; an own
// workspace/private capability the member simply switched on binds by the same name (there is nothing to map: the
// author and the consumer are the same workspace).
function bindSecrets(record: CapabilityRecord, ref: CapabilityRef | undefined): Record<string, string> {
  const spec = record.spec;
  if (spec.type !== "mcp" && spec.type !== "code") return {};
  const bindings: Record<string, string> = {};
  for (const rs of spec.requiredSecrets) bindings[rs.name] = ref?.secretBindings[rs.name] ?? rs.name;
  return bindings;
}

function capabilityCandidate(
  record: CapabilityRecord,
  opts: { tenant: string; ref?: CapabilityRef; baseline: boolean },
): ResolvedAgentTool | undefined {
  const spec = record.spec;
  if (spec.type !== "mcp" && spec.type !== "code") return undefined; // skills + environments are not agent TOOLS
  const writes =
    spec.type === "mcp" ? spec.write && (opts.ref === undefined || opts.ref.enableWrite) : !spec.isReadOnly;
  return {
    key: capabilityToolKey(record.tenant, record.id),
    name: record.name,
    description: record.description,
    type: spec.type,
    // A private publication is visible to its author alone — that is exactly "a tool only I use".
    scope: record.visibility === "private" ? "personal" : "workspace",
    enabled: false, // decided below
    baseline: opts.baseline,
    writes,
    secretBindings: bindSecrets(record, opts.ref),
    owner: record.tenant,
    version: record.version,
    origin: { channel: "capability", record },
  };
}

// A skill in the member's library — a procedure their agent may follow. ONE channel, deliberately: every skill the
// agent follows is a SkillRecord this workspace owns. A skill-kind capability in the store is an EXAMPLE to copy
// (SkillService.importFromStore turns it into one of these), never a live attachment — so what Settings › Agent ›
// Skills lists and what the agent actually follows are the same set, and every entry is editable and versionable by
// the people it belongs to.
export type AgentSkillOrigin = { channel: "authored"; record: SkillRecord };

export interface ResolvedAgentSkill {
  key: string;
  name: string;
  description: string;
  scope: AgentToolScope;
  enabled: boolean; // effective for THIS member
  baseline: boolean; // what the workspace put on the table
  owner: string; // the workspace that owns it ("" for an authored skill of the caller's own tenant)
  version?: string;
  shadowedBy?: string;
  origin: AgentSkillOrigin;
}

// What one resolution pass produces — both channels, from one pass over the workspace's baseline. They share it
// because the adopted references carry BOTH kinds: resolving them once is the difference between one fetch per
// reference and two.
export interface AgentCapabilitiesResolution {
  tools: ResolvedAgentTool[];
  skills: ResolvedAgentSkill[];
}

// The two candidate pools, each in RUNTIME PRIORITY order — a contested name is won by the first ENABLED candidate:
//  · tools  — hand-wired servers → adopted capabilities → merely available ones → first-party defaults
//  · skills — the workspace's authored library, and nothing else (store skills arrive by being copied INTO it)
// Order is load-bearing for tools: it preserves the established "an adopted entry shadows a built-in default" rule.
async function candidatePools(
  deps: AgentCapabilitiesDeps,
  query: AgentCapabilitiesQuery,
): Promise<AgentCapabilitiesResolution> {
  const { tenant, subject, agentId } = query;
  let spec: AgentSpec | undefined = query.spec;
  if (!spec) {
    try {
      spec = await deps.agentRegistry.get(tenant, agentId, "latest");
    } catch {
      spec = undefined; // no registered agent → no workspace baseline beyond the first-party defaults
    }
  }

  const pool: ResolvedAgentTool[] = [];
  const skills: ResolvedAgentSkill[] = [];

  // The workspace's authored skill library — the shared skills plus the caller's own private drafts (the store scopes
  // the read). Both are on the table for their reader; the member decides which ones their agent actually follows.
  let authored: SkillRecord[] = [];
  try {
    authored = (await deps.skillStore?.list(tenant, subject)) ?? [];
  } catch {
    authored = [];
  }
  for (const record of authored) {
    skills.push({
      key: authoredSkillKey(record.id),
      name: record.name,
      description: record.description,
      scope: record.visibility === "private" ? "personal" : "workspace",
      enabled: false, // decided below
      baseline: true, // owned here = the workspace supports it
      owner: "",
      version: record.version, // the last content the workspace stamped (the row itself is the working copy)
      origin: { channel: "authored", record },
    });
  }

  for (const server of spec?.mcpServers ?? []) {
    pool.push({
      key: mcpServerToolKey(server.name),
      name: server.name,
      description: server.url,
      type: "mcp",
      scope: "workspace",
      enabled: false,
      baseline: true, // hand-wired on the workspace's own agent = on the table for everyone
      writes: server.write,
      secretBindings: server.authSecret !== undefined ? { Authorization: server.authSecret } : {},
      owner: "",
      origin: { channel: "mcpServer", server },
    });
  }

  // Adopted Store capabilities — immutable-version references resolved cross-tenant, visibility re-checked at load
  // time (a revoked/unpublished capability degrades to skipped, exactly as the runtime used to do inline).
  const adoptedKeys = new Set<string>();
  for (const ref of spec?.capabilities ?? []) {
    let record: CapabilityRecord | undefined;
    try {
      record = await deps.capabilityStore.getVersion(ref.source, ref.id, ref.version);
    } catch {
      record = undefined;
    }
    if (!record) continue;
    if (!canConsumeCapability(record, { tenant, subject })) continue;
    const candidate = capabilityCandidate(record, { tenant, ref, baseline: true });
    if (!candidate) continue;
    adoptedKeys.add(candidate.key);
    pool.push(candidate);
  }

  // Everything else this member may use without adopting: the workspace's own published tools and their own private
  // ones. Off by default (the workspace did not put them on the table) — the member switches on what they want.
  let visible: CapabilityRecord[] = [];
  try {
    visible = await deps.capabilityStore.listVisible(tenant, subject);
  } catch {
    visible = [];
  }
  for (const record of visible) {
    // A skill-kind publication is skipped on purpose (capabilityCandidate returns undefined for it): publishing a
    // skill to the store hands other workspaces something to COPY, it does not add a second, uneditable copy of it to
    // the author's own library — the SkillRecord it was published from is already there.
    const candidate = capabilityCandidate(record, { tenant, baseline: false });
    if (!candidate || adoptedKeys.has(candidate.key)) continue; // an adopted pin already speaks for this capability
    pool.push(candidate);
  }

  // First-party defaults last. The integration gate still applies (an ungated default is not a candidate at all —
  // there is nothing a member could switch on), while the workspace's opt-outs become the baseline they override.
  let integrationsConfigured: readonly CapabilityRequirement[] = [];
  try {
    integrationsConfigured = (await deps.integrationsConfigured?.(tenant)) ?? [];
  } catch {
    integrationsConfigured = [];
  }
  const disabledDefaults = spec?.disabledDefaults ?? [];
  const gated = selectDefaultCapabilities(
    firstPartyDefaults().map((d) => ({ id: d.record.id, name: d.record.name, requires: d.requires, def: d })),
    // Opt-outs + name shadowing are decided per MEMBER below, so the gate here is the integration one only.
    { integrationsConfigured, disabledDefaults: [], takenNames: [] },
  );
  for (const { def } of gated) {
    const spec_ = def.record.spec;
    if (spec_.type !== "mcp" && spec_.type !== "code") continue; // the defaults are tools only — skills are examples
    pool.push({
      key: builtinToolKey(def.record.id),
      name: def.record.name,
      description: def.record.description,
      type: spec_.type,
      scope: "builtin",
      enabled: false,
      baseline: !disabledDefaults.includes(def.record.id),
      writes: spec_.type === "mcp" ? spec_.write : !spec_.isReadOnly,
      secretBindings: Object.fromEntries(spec_.requiredSecrets.map((rs) => [rs.name, rs.name])),
      owner: def.record.tenant,
      version: def.record.version,
      origin: { channel: "builtin", builtin: def },
    });
  }
  return { tools: pool, skills };
}

// The member's agent: the workspace baseline overlaid with their own decisions, for both channels. Every candidate is
// returned (the settings pages list what is available, not only what is on), each carrying its effective `enabled`.
export async function resolveAgentCapabilities(
  deps: AgentCapabilitiesDeps,
  query: AgentCapabilitiesQuery,
): Promise<AgentCapabilitiesResolution> {
  const { tools, skills } = await candidatePools(deps, query);
  let preferences: { tools: Record<string, boolean>; skills: Record<string, boolean> } = { tools: {}, skills: {} };
  try {
    const stored = await deps.preferences?.get(query.tenant, query.subject);
    if (stored) preferences = { tools: stored.tools, skills: stored.skills };
  } catch {
    // the personal layer is an overlay: losing it degrades to the workspace baseline, never to an empty agent
  }
  const decided = <T extends { key: string }>(
    candidate: T,
    selection: { enabled: boolean; shadowedBy?: string },
  ): T => ({
    ...candidate,
    enabled: selection.enabled,
    ...(selection.shadowedBy !== undefined ? { shadowedBy: selection.shadowedBy } : {}),
  });
  return {
    tools: selectForMember(tools, preferences.tools).map((s) => decided(s.candidate, s)),
    skills: selectForMember(skills, preferences.skills).map((s) => decided(s.candidate, s)),
  };
}
