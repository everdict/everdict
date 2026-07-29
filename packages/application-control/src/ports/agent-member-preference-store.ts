import type { AgentMemberPreferences, AgentPreferenceChannel } from "@everdict/contracts";

// Persistence port for the per-MEMBER agent overlay — "which of what this workspace supports do I want MY agent to
// carry": the tools it can call and the skills it follows. Self-scoped: a row belongs to (tenant, subject) and only
// that member reads/writes it (no admin surface — the workspace-wide baseline is the AgentSpec + the skill library).
// Impls: InMemory / Pg in @everdict/db.
export interface AgentMemberPreferenceStore {
  // The member's overrides. undefined = never configured anything ⇒ they follow the workspace baseline entirely.
  get(tenant: string, subject: string): Promise<AgentMemberPreferences | undefined>;

  // Set ONE entry's decision in one channel. `enabled: null` REMOVES the override (back to following the workspace
  // baseline) — a distinct outcome from storing the baseline's current value, which would freeze the member at it.
  setEntry(
    tenant: string,
    subject: string,
    channel: AgentPreferenceChannel,
    key: string,
    enabled: boolean | null,
  ): Promise<AgentMemberPreferences>;
}
