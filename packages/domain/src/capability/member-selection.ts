// The per-MEMBER selection kernel — the single authority for "which of what this workspace supports does THIS
// member's agent carry". Used for BOTH channels: the tools it can call and the skills it follows.
// Pure (no I/O): given the candidates a workspace put on the table (with the workspace baseline for each) and the
// member's own overrides, it decides the effective on/off and which candidate wins a contested name. The workspace
// AgentSpec + skill library stay the shared baseline; this is what makes two members of one workspace get two
// different agents. Resolution + adapter shaping happen in the application layer (resolveAgentCapabilities).

// The stable identity of an entry across the channels a workspace can put one on the table from. The prefixes are
// contract vocabulary (AGENT_PREFERENCE_KEY_PREFIXES); these builders are the only place a key is spelled.
export function builtinToolKey(capabilityId: string): string {
  return `default:${capabilityId}`;
}
export function capabilityToolKey(owner: string, id: string): string {
  return `capability:${owner}/${id}`;
}
export function mcpServerToolKey(serverName: string): string {
  return `mcp:${serverName}`;
}
// An authored Skill record (skills channel only — a tool is never authored this way).
export function authoredSkillKey(skillId: string): string {
  return `skill:${skillId}`;
}

// The minimal shape the decision needs — an adapter-side candidate (carrying its record/ref/server) satisfies it.
export interface MemberSelectionCandidate {
  key: string;
  name: string; // the name the model sees — contested names are resolved by priority below
  // What a member who never touched this entry gets: true for the workspace's own baseline (adopted capabilities, raw
  // MCP servers, authored skills, non-opted-out first-party defaults), false for what is merely AVAILABLE
  // (workspace-published capabilities nobody adopted).
  baseline: boolean;
}

export interface MemberSelection<T extends MemberSelectionCandidate> {
  candidate: T;
  enabled: boolean; // effective for this member
  shadowedBy?: string; // key of the enabled entry that already owns this name (this one cannot be offered)
}

// Overlay the member's explicit decisions on the workspace baseline, then resolve name collisions.
//
// Two rules, in this order:
//  1. Override — `preferences[key]` (absent ⇒ the baseline). Deleting the key is how a member goes back to following
//     the workspace, so an absent key is never rewritten to the baseline value.
//  2. Shadowing — one NAME can be offered once. Among the enabled candidates for a name the FIRST in input order
//     wins; the others are reported (shadowedBy) rather than silently dropped, so the UI can explain it. Callers pass
//     candidates in runtime-priority order (authored/adopted before first-party defaults), which preserves the
//     existing "an authored/adopted same-named entry shadows a built-in default" rule.
//
// Deterministic and order-preserving: the result mirrors the input sequence.
export function selectForMember<T extends MemberSelectionCandidate>(
  candidates: readonly T[],
  preferences: Readonly<Record<string, boolean>>,
): MemberSelection<T>[] {
  const ownerOfName = new Map<string, string>();
  return candidates.map((candidate) => {
    const override = preferences[candidate.key];
    const enabled = override ?? candidate.baseline;
    if (!enabled) return { candidate, enabled: false };
    const owner = ownerOfName.get(candidate.name);
    if (owner !== undefined) return { candidate, enabled: false, shadowedBy: owner };
    ownerOfName.set(candidate.name, candidate.key);
    return { candidate, enabled: true };
  });
}
