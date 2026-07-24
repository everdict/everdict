import type { AgentEventSink } from "@everdict/application-control";

// Push a platform event to the agent service's internal /agent/events endpoint (S4 — the monitoring→proactive-team
// bridge, docs/architecture/agent-teams.md). Authenticated with the shared internal token; the agent fans the event to
// the recipient's watching teammates. Fire-and-forget from the caller's view — the NotificationService wraps this in a
// try/catch so an unreachable/misconfigured agent never affects the run/scorecard result.
export function httpAgentEventSink(agentUrl: string, internalToken: string): AgentEventSink {
  const url = `${agentUrl.replace(/\/$/, "")}/agent/events`;
  return {
    async emit(input) {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken },
        body: JSON.stringify(input),
      });
    },
  };
}
