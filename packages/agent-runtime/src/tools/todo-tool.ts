import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "./definition.js";

// A single tracked step of a multi-turn task. `content` is the imperative form ("Summarize the failures"), `activeForm`
// the present-continuous form shown while it's the one in progress ("Summarizing the failures").
export interface TodoItem {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

export const WRITE_TODOS_TOOL_NAME = "write_todos";

// Parse a raw `todos` argument into validated items (used by the tool + by history bootstrap). Bad entries are skipped.
export function parseTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (t === null || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const status = o.status;
    if (typeof o.content !== "string" || o.content.length === 0) continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    out.push({ content: o.content, activeForm: typeof o.activeForm === "string" ? o.activeForm : o.content, status });
  }
  return out;
}

// The loop owns the todo list; this native (always-loaded) tool lets the model create or REPLACE it. The list is
// re-surfaced to the model each turn (renderTodoReminder) so a long task stays on-goal — Claude Code parity.
export function buildTodoTool(setTodos: (todos: TodoItem[]) => void): ToolDefinition {
  return {
    name: WRITE_TODOS_TOOL_NAME,
    description:
      "Track a multi-step task as a checklist so you don't lose the thread across turns. Call this to create or " +
      "REPLACE the full todo list. Use it for any task with roughly 3+ steps: write the steps up front, keep exactly " +
      "one item in_progress while you work it, and mark it completed the moment it's done. A stale list is worse than " +
      "none — keep it current. Skip it for trivial single-step requests.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full todo list — this REPLACES any previous list.",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "The task in imperative form (e.g. 'Summarize the scorecard failures').",
              },
              activeForm: {
                type: "string",
                description:
                  "Present-continuous form shown while in progress (e.g. 'Summarizing the scorecard failures').",
              },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "activeForm", "status"],
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const todos = parseTodos((input as { todos?: unknown }).todos);
      setTodos(todos);
      const done = todos.filter((t) => t.status === "completed").length;
      return { content: `Updated todo list — ${done}/${todos.length} completed.`, isError: false };
    },
  };
}

// The current todos rendered as a system-reminder the loop injects each turn (transient — not persisted into the
// transcript) so the goal stays in front of the model over many turns. Empty list → no reminder.
export function renderTodoReminder(todos: TodoItem[]): string {
  if (todos.length === 0) return "";
  const lines = todos.map((t) => {
    const box = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
    return `${box} ${t.status === "in_progress" ? t.activeForm : t.content}`;
  });
  return [
    "<system-reminder>",
    "Your current todo list (update it with write_todos as you make progress; mark items completed as you finish them):",
    ...lines,
    "</system-reminder>",
  ].join("\n");
}

// Seed the loop's todos from a prior run in the same conversation — scan the replayed history for the LAST write_todos
// tool call and parse its arguments, so a continued conversation keeps its checklist.
export function extractTodosFromHistory(messages: ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc.type !== "function" || tc.function.name !== WRITE_TODOS_TOOL_NAME) continue;
      try {
        const args = JSON.parse(tc.function.arguments) as { todos?: unknown };
        return parseTodos(args.todos);
      } catch {
        return [];
      }
    }
  }
  return [];
}
