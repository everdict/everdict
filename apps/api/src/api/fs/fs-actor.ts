import type { Principal } from "@everdict/auth";
import type { FsActor } from "@everdict/contracts";

// WHO is publishing this revision. A workspace file is written by members AND by agents acting for them, and the
// history is only useful if it can tell them apart — "the analyst agent rewrote your report in conversation X"
// reads very differently from "your teammate rewrote it".
//
// The agent identity travels as request headers because an agent calls the control plane WITH THE MEMBER'S OWN
// credential (apps/agent is a token courier): the bearer says which member, the headers say which agent ran on
// their behalf. That is provenance, not privilege — the write is authorized by the member's token either way, so
// a forged header can only mislabel the caller's OWN publish, never widen what it may do.
export const AGENT_ID_HEADER = "x-everdict-agent-id";
export const AGENT_NAME_HEADER = "x-everdict-agent-name";
export const CONVERSATION_HEADER = "x-everdict-conversation-id";

export interface AgentAttribution {
  agentId?: string;
  agentName?: string;
  conversationId?: string;
}

const MAX = 200; // headers are attacker-influencable; keep the stored labels bounded

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, MAX);
  return trimmed === "" ? undefined : trimmed;
}

export function agentAttributionFrom(headers: Record<string, unknown>): AgentAttribution | undefined {
  const agentId = header(headers, AGENT_ID_HEADER);
  const conversationId = header(headers, CONVERSATION_HEADER);
  if (agentId === undefined && conversationId === undefined) return undefined;
  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(header(headers, AGENT_NAME_HEADER) !== undefined ? { agentName: header(headers, AGENT_NAME_HEADER) } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
}

// The member's own edit unless an agent declared itself — then the agent is the author and the member is who it
// acted for, so a rollback knows whose work it is undoing.
export function fsActorFor(principal: Principal, agent?: AgentAttribution): FsActor {
  if (!agent) return { kind: "member", subject: principal.subject };
  return {
    kind: "agent",
    subject: principal.subject,
    ...(agent.agentId !== undefined ? { agentId: agent.agentId } : {}),
    ...(agent.agentName !== undefined ? { agentName: agent.agentName } : {}),
    ...(agent.conversationId !== undefined ? { conversationId: agent.conversationId } : {}),
    onBehalfOf: principal.subject,
  };
}
