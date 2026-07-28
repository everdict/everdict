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
