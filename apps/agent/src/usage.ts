import type { TraceEvent, TraceSpan } from "@everdict/contracts";

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
  // P3 ledger correlation (optional): the run id this report opens/settles on the CP's universal ledger.
  runId?: string;
  agentVersion?: string;
  eventId?: string;
  creator?: string;
  budgetUsd?: number; // the delegated slice (A7/§5.2) — the CP stamps it as the run's envelope
  // What opened this run (O1): an activation woken by a platform event (default), or a chat turn a member
  // typed. A chat turn is recorded on the ledger but stays OFF the event log — see the CP route.
  cause?: "event" | "chat";
  // O2 (transcripts are traces): a terminal report's transcript projection — the CP seals it as the run's
  // own trajectory (source "run", first write wins).
  trace?: TraceEvent[];
  // The turn's own SPANS, recorded live off the kernel's events (N6, otel-trace-model.md). When present the
  // CP seals THESE as the record and the transcript projection is not used: the recorder saw the model call's
  // latency, the retries, the compactions and the subagents, none of which a transcript row can hold.
  spans?: TraceSpan[];
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
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
        ...(input.creator !== undefined ? { creator: input.creator } : {}),
        ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
        ...(input.cause !== undefined ? { cause: input.cause } : {}),
        ...(input.trace !== undefined ? { trace: input.trace } : {}),
      }),
    });
    if (!res.ok) throw new Error(`agent-run event report failed: ${res.status}`);
  };
}

// Activation-admission bridge (§5.1 "reactions pass the gate"): ask the control plane's tenant budget
// before a headless run launches. An explicit 402 denies (the activator skips VISIBLY); a transport
// failure fails OPEN — the reconcile loop only delivers events while the CP is reachable anyway, and a
// budget must never be enforced by an outage.
export function admissionBridge(
  controlPlaneUrl: string,
  internalToken: string,
): (workspace: string) => Promise<{ admitted: boolean; reason?: string }> {
  const url = `${controlPlaneUrl.replace(/\/$/, "")}/internal/activations/admit`;
  return async (workspace) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken },
        body: JSON.stringify({ tenant: workspace }),
      });
      if (res.ok) return { admitted: true };
      if (res.status === 402) {
        const body = (await res.json().catch(() => ({}))) as { message?: unknown };
        return { admitted: false, reason: typeof body.message === "string" ? body.message : "budget exceeded" };
      }
      return { admitted: true }; // 404 = gate not wired on this CP — never a silent lockout
    } catch {
      return { admitted: true }; // CP unreachable — fail open (see header)
    }
  };
}

// Durable-approval bridge (A6): register a park on the control plane (POST /internal/approvals — the ask
// survives an agent-service restart) and settle the ledger after the in-process wait resolves (the legacy
// fleet channel and local expiry converge through the same settle; an already-decided record skips there).
export function approvalBridge(
  controlPlaneUrl: string,
  internalToken: string,
): {
  register(input: {
    tenant: string;
    sessionId: string;
    agentId?: string;
    requestId: string;
    request: { name: string; input?: unknown };
  }): Promise<{ id: string; expiresAt: string }>;
  settle(id: string, tenant: string, decision: "approve" | "deny"): Promise<void>;
} {
  const base = controlPlaneUrl.replace(/\/$/, "");
  return {
    async register(input) {
      const res = await fetch(`${base}/internal/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`approval register failed: ${res.status}`);
      const json = (await res.json()) as { id?: unknown; expiresAt?: unknown };
      if (typeof json.id !== "string" || typeof json.expiresAt !== "string")
        throw new Error("approval register returned an invalid record");
      return { id: json.id, expiresAt: json.expiresAt };
    },
    async settle(id, tenant, decision) {
      const res = await fetch(`${base}/internal/approvals/${encodeURIComponent(id)}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken },
        body: JSON.stringify({ tenant, decision }),
      });
      if (!res.ok) throw new Error(`approval settle failed: ${res.status}`);
    },
  };
}
