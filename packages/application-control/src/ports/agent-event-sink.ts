// A sink the control plane uses to push a platform event to the agent service, where it fans out to the recipient's
// proactive teammates that watch its kind (docs/architecture/agent-teams.md S4). The impl (an HTTP client to the agent
// service's internal /agent/events) lives in apps/api; the NotificationService calls this best-effort — an unreachable
// or unconfigured agent must NEVER affect the run/scorecard result (like the feed/Mattermost channels).
export interface AgentEventSink {
  emit(input: {
    workspace: string;
    recipient: string; // the subject whose watching teammates should react (the run/scorecard creator)
    kind: string; // e.g. "scorecard.completed" / "run.failed" — teammates subscribe to these
    source?: string; // a human label for the event's origin (e.g. "scorecard sc_123")
    message: string;
  }): Promise<void>;
}
