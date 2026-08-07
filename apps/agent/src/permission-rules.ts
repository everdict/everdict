import type { PermissionDecision } from "@everdict/agent-runtime";

// Fine-grained, session-scoped permission rules — the "always allow / always deny this tool" layer above the coarse
// control-plane RBAC (which already gates every tool call by the caller's role). When a write tool needs approval, the
// HITL permit hook consults these first: a matching rule short-circuits the human prompt (auto-allow / auto-deny), so a
// member can say "always allow do_write for this conversation" instead of being asked every time. This map is the hot
// path; durability lives on the session record (LESSON 059 P4): every change writes through, and a session unseen
// since boot hydrates from the record once — a restart no longer reopens prompts the member answered with "always".
export class PermissionRules {
  private readonly rules = new Map<string, Map<string, PermissionDecision>>();

  private keyOf(workspace: string, sessionId: string): string {
    return `${workspace}:${sessionId}`;
  }

  // Whether this session's rules are already in memory (hydrated or mutated) — the read paths use it to decide
  // whether to consult the durable record first.
  has(workspace: string, sessionId: string): boolean {
    return this.rules.has(this.keyOf(workspace, sessionId));
  }

  // Seed a session's rules from the durable record. No-clobber: if anything is already in memory (a rule set
  // since boot), the in-memory state is newer and wins. An empty object still marks the session hydrated, so
  // the record is read at most once per process.
  hydrate(workspace: string, sessionId: string, stored: Record<string, PermissionDecision>): void {
    const key = this.keyOf(workspace, sessionId);
    if (this.rules.has(key)) return;
    this.rules.set(key, new Map(Object.entries(stored)));
  }

  // Add or replace a rule for a tool in a session.
  set(workspace: string, sessionId: string, tool: string, decision: PermissionDecision): void {
    const key = this.keyOf(workspace, sessionId);
    const forSession = this.rules.get(key) ?? new Map<string, PermissionDecision>();
    forSession.set(tool, decision);
    this.rules.set(key, forSession);
  }

  // The standing decision for a tool in a session, or undefined if none (→ fall through to the human prompt).
  get(workspace: string, sessionId: string, tool: string): PermissionDecision | undefined {
    return this.rules.get(this.keyOf(workspace, sessionId))?.get(tool);
  }

  // Remove a tool's rule (→ the tool asks again). No-op if absent.
  clear(workspace: string, sessionId: string, tool: string): void {
    this.rules.get(this.keyOf(workspace, sessionId))?.delete(tool);
  }

  // All rules for a session, as a plain object (for GET /rules).
  list(workspace: string, sessionId: string): Record<string, PermissionDecision> {
    const forSession = this.rules.get(this.keyOf(workspace, sessionId));
    return forSession ? Object.fromEntries(forSession) : {};
  }
}
