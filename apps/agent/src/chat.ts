import { type ChatMessage, runAgentLoop } from "@everdict/agent-runtime";
import type { AgentSessionStore } from "@everdict/application-control";
import { type AgentMessageRecord, type AgentToolCall, NotFoundError } from "@everdict/contracts";
import type { ToolProvider } from "./mcp-tools.js";
import type { ModelResolver } from "./model.js";
import type { ForwardHeaders, Principal } from "./principal.js";

export interface ChatDeps {
  sessions: AgentSessionStore;
  resolveModel: ModelResolver;
  toolProvider: ToolProvider;
  systemPrompt: string;
  now: () => string;
  newId: () => string;
  maxTurns?: number;
}

export interface ChatResult {
  messages: AgentMessageRecord[]; // the newly produced tail (user echo + assistant/tool turns), seq-ordered
}

export const DEFAULT_SESSION_TITLE = "New conversation";

function contentToString(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}

// Replay stored records into the OpenAI message shape the loop expects (assistant tool_calls ↔ tool results).
function recordsToHistory(records: AgentMessageRecord[]): ChatMessage[] {
  return records.map((r): ChatMessage => {
    if (r.role === "assistant") {
      if (r.toolCalls && r.toolCalls.length > 0) {
        return {
          role: "assistant",
          ...(r.content.length > 0 ? { content: r.content } : {}),
          tool_calls: r.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: "assistant", content: r.content };
    }
    if (r.role === "tool") {
      return { role: "tool", tool_call_id: r.toolCallId ?? "", content: r.content };
    }
    return { role: "user", content: r.content };
  });
}

function extractToolCalls(message: ChatMessage): AgentToolCall[] | undefined {
  if (message.role !== "assistant") return undefined;
  const tcs = message.tool_calls;
  if (!tcs || tcs.length === 0) return undefined;
  const out: AgentToolCall[] = [];
  for (const tc of tcs) {
    if (tc.type !== "function") continue;
    out.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
  }
  return out.length > 0 ? out : undefined;
}

function deriveTitle(userText: string): string {
  const firstLine = userText.split("\n")[0]?.trim() ?? "";
  const title = firstLine.length > 0 ? firstLine : DEFAULT_SESSION_TITLE;
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

// One chat turn: persist the user message, replay history into the kernel, run the loop with the workspace's
// read-only MCP tools, then persist the produced assistant/tool transcript. Returns the new tail for the caller.
export async function runChat(
  deps: ChatDeps,
  principal: Principal,
  headers: ForwardHeaders,
  sessionId: string,
  userText: string,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const { workspace, subject } = principal;
  const session = await deps.sessions.getSession(workspace, subject, sessionId);
  if (!session) throw new NotFoundError("NOT_FOUND", undefined, "Conversation not found.");

  const existing = await deps.sessions.listMessages(workspace, sessionId);
  let seq = existing.length === 0 ? 0 : Math.max(...existing.map((m) => m.seq)) + 1;

  const userRecord: AgentMessageRecord = {
    id: deps.newId(),
    tenant: workspace,
    sessionId,
    seq: seq++,
    role: "user",
    content: userText,
    createdAt: deps.now(),
  };
  await deps.sessions.appendMessages([userRecord]);

  const history: ChatMessage[] = [...recordsToHistory(existing), { role: "user", content: userText }];

  const tools = await deps.toolProvider(headers);
  let produced: ChatMessage[] = [];
  try {
    const model = await deps.resolveModel(principal);
    const result = await runAgentLoop({
      client: model.client,
      model: model.model,
      systemPrompt: deps.systemPrompt,
      history,
      registry: tools.registry,
      ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      ...(signal ? { signal } : {}),
    });
    produced = result.produced;
  } finally {
    await tools.close();
  }

  const producedRecords: AgentMessageRecord[] = [];
  for (const message of produced) {
    if (message.role === "assistant") {
      const toolCalls = extractToolCalls(message);
      producedRecords.push({
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "assistant",
        content: contentToString(message.content),
        ...(toolCalls ? { toolCalls } : {}),
        createdAt: deps.now(),
      });
    } else if (message.role === "tool") {
      producedRecords.push({
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "tool",
        content: contentToString(message.content),
        toolCallId: message.tool_call_id,
        createdAt: deps.now(),
      });
    }
  }
  if (producedRecords.length > 0) await deps.sessions.appendMessages(producedRecords);

  const nextTitle = session.title === DEFAULT_SESSION_TITLE ? deriveTitle(userText) : undefined;
  await deps.sessions.touchSession(workspace, sessionId, deps.now(), nextTitle);

  return { messages: [userRecord, ...producedRecords] };
}
