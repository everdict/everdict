// Report a conversation's LLM token usage to the control plane's internal meter bridge (POST /internal/usage,
// x-internal-token). The control plane prices the tokens and records + settles them as source "agent", so agent
// cost lands in the SAME meter + enforcement budget as evals. The caller (runChat) swallows failures — metering
// must never break a chat. docs/architecture/usage-metering.md
export interface UsageReport {
  workspace: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function usageReporter(controlPlaneUrl: string, internalToken: string): (usage: UsageReport) => Promise<void> {
  const url = `${controlPlaneUrl.replace(/\/$/, "")}/internal/usage`;
  return async (usage) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify({
        tenant: usage.workspace,
        source: "agent",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
    });
    if (!res.ok) throw new Error(`usage report failed: ${res.status}`);
  };
}

// Report an agent.run.* lifecycle FACT to the control plane's event log (POST /internal/agent-run-events —
// fleet observability, agent-automation A5). Best-effort at the call site (the activator swallows failures).
export interface AgentRunEventReport {
  workspace: string;
  kind:
    | "agent.run.started"
    | "agent.run.awaiting_approval"
    | "agent.run.completed"
    | "agent.run.failed"
    | "agent.run.cancelled";
  sessionId: string;
  agentId: string;
  eventKind: string;
  message: string;
}

export function runEventReporter(
  controlPlaneUrl: string,
  internalToken: string,
): (input: AgentRunEventReport) => Promise<void> {
  const url = `${controlPlaneUrl.replace(/\/$/, "")}/internal/agent-run-events`;
  return async (input) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify({
        tenant: input.workspace,
        kind: input.kind,
        sessionId: input.sessionId,
        agentId: input.agentId,
        eventKind: input.eventKind,
        message: input.message,
      }),
    });
    if (!res.ok) throw new Error(`agent-run event report failed: ${res.status}`);
  };
}
