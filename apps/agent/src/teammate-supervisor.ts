// S3 (docs/architecture/agent-teams.md) — the execution-control core for persistent teammates. A teammate is a
// long-lived agent that reacts to messages WITHOUT a human prompt: when a message lands in its mailbox, the supervisor
// wakes a turn. Turns are SERIALIZED per teammate — only one runs at a time, and messages that arrive mid-turn coalesce
// into one follow-up turn (no pile-up, no lost wake). This same "a message/event wakes an agent" primitive powers
// proactive agents (S5): a monitoring event routed to a teammate's mailbox wakes it just like a peer's message.
//
// `runTurn(sessionId)` is injected — it drains the teammate's mailbox and runs one agent turn (persisting it). The
// supervisor only owns WHEN a turn runs (wake + serialize), never HOW; that keeps it pure + unit-testable and lets the
// host wire the real turn (mailbox drain → runChat) separately.

export type RunTeammateTurn = (sessionId: string) => Promise<void>;

export class TeammateSupervisor {
  // key = sessionId (a teammate's address). running = a turn is in flight; dirty = a wake arrived during that turn.
  private readonly teammates = new Map<string, { name: string; running: boolean; dirty: boolean }>();

  constructor(private readonly runTurn: RunTeammateTurn) {}

  // Register a session as a teammate — the supervisor now wakes it on messages. Idempotent (re-register keeps state).
  register(sessionId: string, name: string): void {
    const existing = this.teammates.get(sessionId);
    if (existing) {
      existing.name = name;
      return;
    }
    this.teammates.set(sessionId, { name, running: false, dirty: false });
  }

  // Stop watching a teammate (it becomes a plain session again). An in-flight turn finishes but won't re-run.
  unregister(sessionId: string): void {
    this.teammates.delete(sessionId);
  }

  isTeammate(sessionId: string): boolean {
    return this.teammates.has(sessionId);
  }

  list(): { sessionId: string; name: string }[] {
    return [...this.teammates.entries()].map(([sessionId, t]) => ({ sessionId, name: t.name }));
  }

  // A message arrived for this teammate → ensure it runs a turn. If one is already running, mark it dirty so it runs
  // again once the current turn settles (mid-turn messages coalesce into a single follow-up). No-op for non-teammates.
  wake(sessionId: string): void {
    const t = this.teammates.get(sessionId);
    if (!t) return;
    if (t.running) {
      t.dirty = true;
      return;
    }
    void this.drive(sessionId);
  }

  private async drive(sessionId: string): Promise<void> {
    const t = this.teammates.get(sessionId);
    if (!t || t.running) return;
    t.running = true;
    try {
      // Run turns until no wake arrived during the last one — a message delivered mid-turn is picked up here, not lost.
      do {
        t.dirty = false;
        await this.runTurn(sessionId);
      } while (t.dirty && this.teammates.has(sessionId));
    } finally {
      t.running = false;
    }
  }
}
