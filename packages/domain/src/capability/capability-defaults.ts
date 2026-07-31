import type { CapabilityRequirement, WorkspaceSettings } from "@everdict/contracts";
import { mattermostConnections } from "../workspace/mattermost-connections.js";

// The first-party DEFAULT-toolset selection kernel — the single authority for "does this default apply to this
// workspace right now". Pure (no I/O): given the workspace's configured integrations, its opt-outs, and the tool names
// already taken by adopted/authored tools, it decides which first-party defaults belong in the agent's toolset. Secret
// resolution + adapter shaping happen in the runtime resolver (apps/agent). See docs/architecture/capability-store.md.

// The minimal shape the decision needs — a first-party default (a full record + its requirement) satisfies it.
export interface DefaultCapabilityInput {
  id: string; // the capability id — a workspace opt-out (AgentSpec.disabledDefaults) is keyed by this
  name: string; // the tool name the agent sees — a same-named adopted/authored tool SHADOWS the default
  requires: CapabilityRequirement | null; // the integration gate (null = unconditional, e.g. web search)
}

export interface DefaultSelectionContext {
  integrationsConfigured: readonly CapabilityRequirement[]; // integrations the workspace has configured
  disabledDefaults: readonly string[]; // capability ids the workspace opted out of
  takenNames: readonly string[]; // tool names already provided by adopted/authored tools (shadow the default)
}

// WorkspaceSettings → the integrations configured on it, in the CapabilityRequirement vocabulary. The pure derivation
// the runtime resolver feeds into selectDefaultCapabilities (apps/agent wires it over the settings store). undefined
// settings (workspace never configured anything) ⇒ no integrations — the gated defaults simply stay off.
export function configuredIntegrations(settings: WorkspaceSettings | undefined): CapabilityRequirement[] {
  if (!settings) return [];
  const configured: CapabilityRequirement[] = [];
  // Plural connections first; the legacy singular registration still counts (mattermostConnections folds it in).
  if (mattermostConnections(settings).length > 0) configured.push("mattermost");
  if ((settings.githubApp?.installations.length ?? 0) > 0) configured.push("github");
  // Plural roster first; the legacy singular registry still counts (read-compat, see WorkspaceSettingsSchema).
  if ((settings.imageRegistries?.length ?? 0) > 0 || settings.imageRegistry) configured.push("image-registry");
  return configured;
}

// Filter first-party defaults to the ones that apply: not opted out (by id), not shadowed by a same-named tool, and —
// when the default depends on an integration — only if that integration is configured. Deterministic (preserves the
// input order). Everything that decides whether a default is offered lives here; the runtime only shapes what survives.
export function selectDefaultCapabilities<T extends DefaultCapabilityInput>(
  defaults: readonly T[],
  ctx: DefaultSelectionContext,
): T[] {
  const disabled = new Set(ctx.disabledDefaults);
  const taken = new Set(ctx.takenNames);
  const configured = new Set(ctx.integrationsConfigured);
  return defaults.filter(
    (d) => !disabled.has(d.id) && !taken.has(d.name) && (d.requires === null || configured.has(d.requires)),
  );
}
