import { type ChatMessage, type SkillEntry, runAgentLoop } from "@everdict/agent-runtime";
import { contentToString, extractToolCalls } from "./chat.js";
import type { ToolProvider } from "./mcp-tools.js";
import type { ModelResolver } from "./model.js";
import type { ForwardHeaders, Principal } from "./principal.js";

// Skill test-drive — verify a SKILL actually drives the agent well BEFORE saving it (mirrors the judge preview /
// code-judge dry-run). Runs a stateless agent turn (no session persistence) with ONLY this skill available (plus the
// built-in read-only tools) against a sample request, and returns the transcript so the member can see whether the
// agent loaded the skill (use_skill) and followed its steps. Uses the workspace's real data via the read tools.

export interface SkillTryMessage {
  role: "assistant" | "tool";
  content: string;
  toolCalls?: { name: string; arguments: string }[]; // assistant tool calls (incl. use_skill)
  toolCallId?: string; // for tool results
}
export interface SkillTryResult {
  messages: SkillTryMessage[];
}

export interface SkillTryDeps {
  toolProvider: ToolProvider;
  resolveModel: ModelResolver;
  systemPrompt: string;
  maxTurns?: number;
}

const TEST_PREAMBLE =
  "You are being tested on ONE workspace skill (below). Treat the user's message as a real request: if it matches the " +
  "skill, call `use_skill` to load it and follow its steps, using your read-only tools on this workspace's real data. " +
  "If it doesn't match, say so briefly. Keep the answer concise.";

// One stateless turn with just this skill + the built-in read-only tools. Nothing is persisted.
export async function runSkillTry(
  deps: SkillTryDeps,
  principal: Principal,
  headers: ForwardHeaders,
  skill: SkillEntry,
  message: string,
  signal?: AbortSignal,
): Promise<SkillTryResult> {
  const tools = await deps.toolProvider(headers, [], [skill]); // base read-only MCP + use_skill([this skill])
  try {
    const messages: SkillTryMessage[] = [];
    const model = await deps.resolveModel(principal);
    await runAgentLoop({
      transport: model.transport,
      model: model.model,
      systemPrompt: `${deps.systemPrompt}\n\n## Skill test\n${TEST_PREAMBLE} Skill under test: "${skill.name}".`,
      history: [{ role: "user", content: message }],
      registry: tools.registry,
      onMessage: (m: ChatMessage) => {
        if (m.role === "assistant") {
          const tc = extractToolCalls(m);
          messages.push({
            role: "assistant",
            content: contentToString(m.content),
            ...(tc ? { toolCalls: tc.map((t) => ({ name: t.name, arguments: t.arguments })) } : {}),
          });
        } else if (m.role === "tool") {
          messages.push({ role: "tool", content: contentToString(m.content), toolCallId: m.tool_call_id });
        }
      },
      ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      ...(signal ? { signal } : {}),
    });
    return { messages };
  } finally {
    await tools.close();
  }
}
