// A sink the control plane uses to push a platform event to the agent service, where it (a) wakes the recipient's
// proactive teammates that watch its kind (docs/architecture/agent-teams.md S4) and (b) matches enabled registry
// agents' triggers workspace-wide (docs/architecture/agent-automation.md A3). The impl (an HTTP client to the agent
// service's internal /agent/events) lives in apps/api; the emitter calls this best-effort — an unreachable or
// unconfigured agent must NEVER affect the run/scorecard result (like the feed/Mattermost channels).
export interface AgentEventSink {
  emit(input: {
    workspace: string;
    // Teammate compatibility: the subject whose chat-spawned watching teammates should also react (the run/
    // scorecard creator). Registry-agent trigger matching is workspace-scoped and ignores this.
    recipient?: string;
    kind: string; // e.g. "scorecard.completed" / "run.failed" — teammates + agent triggers subscribe to these
    source?: string; // a human label for the event's origin (e.g. "scorecard sc_123")
    message: string;
    // Platform-event identity + matching context (agent-automation A1/A3) — lets the agent service dedup
    // (eventId), filter triggers declaratively (subject/payload), and skip self-caused events (causedBy).
    eventId?: string;
    subject?: { type: string; id: string };
    payload?: Record<string, unknown>;
    causedBy?: string;
  }): Promise<void>;
}
