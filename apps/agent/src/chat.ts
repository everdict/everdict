import { type ChatMessage, type McpInvoke, runAgentLoop } from "@everdict/agent-runtime";
import type { AgentSessionStore } from "@everdict/application-control";
import {
  type AgentMessageRecord,
  type AgentReference,
  type AgentReferenceType,
  type AgentToolCall,
  NotFoundError,
} from "@everdict/contracts";
import type { ToolProvider } from "./mcp-tools.js";
import type { ModelResolver } from "./model.js";
import type { ForwardHeaders, Principal } from "./principal.js";

// An @-reference resolves to the workspace read tool that fetches that entity's full record.
const REFERENCE_TOOL: Record<AgentReferenceType, string> = {
  harness: "get_harness_instance",
  runtime: "get_runtime",
  run: "get_run",
  dataset: "get_dataset",
  scorecard: "get_scorecard",
  judge: "get_judge",
  view: "get_view",
};

const MAX_REFERENCE_CHARS = 4_000;

// Resolve each @-reference via its read tool and assemble a context preamble the model reads before the user's
// words. Best-effort: an unresolved reference degrades to a note rather than failing the turn.
async function resolveReferences(call: McpInvoke, references: AgentReference[]): Promise<string> {
  const blocks: string[] = [];
  for (const ref of references) {
    const args: Record<string, unknown> = { id: ref.id, ...(ref.version ? { version: ref.version } : {}) };
    let detail: string;
    try {
      const r = await call(REFERENCE_TOOL[ref.type], args);
      detail = r.isError ? `(could not resolve: ${r.content.slice(0, 200)})` : r.content;
    } catch (err) {
      detail = `(could not resolve: ${err instanceof Error ? err.message : String(err)})`;
    }
    if (detail.length > MAX_REFERENCE_CHARS) detail = `${detail.slice(0, MAX_REFERENCE_CHARS)}\n… [truncated]`;
    const tag = ref.version ? `${ref.id}@${ref.version}` : ref.id;
    blocks.push(`### Referenced ${ref.type}: ${ref.label} (${tag})\n${detail}`);
  }
  return `The user attached the following workspace context via @-references. Use it to answer.\n\n${blocks.join("\n\n")}`;
}

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
          // null (not omitted/"") alongside tool_calls — the shape providers accept for a tool-only turn.
          content: r.content.length > 0 ? r.content : null,
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
  references?: AgentReference[],
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
    ...(references && references.length > 0 ? { references } : {}),
    createdAt: deps.now(),
  };
  await deps.sessions.appendMessages([userRecord]);

  const producedRecords: AgentMessageRecord[] = [];
  const messageToRecord = (message: ChatMessage): AgentMessageRecord | null => {
    if (message.role === "assistant") {
      const toolCalls = extractToolCalls(message);
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "assistant",
        content: contentToString(message.content),
        ...(toolCalls ? { toolCalls } : {}),
        createdAt: deps.now(),
      };
    }
    if (message.role === "tool") {
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "tool",
        content: contentToString(message.content),
        toolCallId: message.tool_call_id,
        createdAt: deps.now(),
      };
    }
    return null;
  };
  // Persist each assistant/tool turn the moment the loop produces it, so a polling client sees tool activity as it
  // happens (not only after the whole loop settles).
  const persist = async (message: ChatMessage): Promise<void> => {
    const record = messageToRecord(message);
    if (!record) return;
    await deps.sessions.appendMessages([record]);
    producedRecords.push(record);
  };

  const tools = await deps.toolProvider(headers);
  try {
    // Fold any @-referenced entity context into the user turn the model sees (the persisted record keeps the
    // clean text + the reference metadata separately).
    let userForModel = userText;
    if (references && references.length > 0 && tools.call) {
      const preamble = await resolveReferences(tools.call, references);
      userForModel = `${preamble}\n\n---\n\nUser message:\n${userText}`;
    }
    const history: ChatMessage[] = [...recordsToHistory(existing), { role: "user", content: userForModel }];
    const model = await deps.resolveModel(principal);
    await runAgentLoop({
      client: model.client,
      model: model.model,
      systemPrompt: deps.systemPrompt,
      history,
      registry: tools.registry,
      onMessage: persist,
      ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      ...(signal ? { signal } : {}),
    });
  } finally {
    await tools.close();
  }

  const nextTitle = session.title === DEFAULT_SESSION_TITLE ? deriveTitle(userText) : undefined;
  await deps.sessions.touchSession(workspace, sessionId, deps.now(), nextTitle);

  return { messages: [userRecord, ...producedRecords] };
}
