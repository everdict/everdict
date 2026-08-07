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
// `closeOutNudge` (LESSON 059 P3) is the loop's hook onto the EXACT moment completion-skips happen — the write
// that closes the last open item ("when the last task closed, the loop exited"): it is invoked with the incoming
// list BEFORE setTodos commits it (so the hook's closure still reads the previous list), and whatever it returns
// is appended to the tool result — the one channel the model is guaranteed to read right then.
export function buildTodoTool(
  setTodos: (todos: TodoItem[]) => void,
  opts?: { closeOutNudge?: (next: TodoItem[]) => string | undefined },
): ToolDefinition {
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
      const nudge = opts?.closeOutNudge?.(todos); // before setTodos — the hook reads the PREVIOUS list
      setTodos(todos);
      const done = todos.filter((t) => t.status === "completed").length;
      return {
        content: `Updated todo list — ${done}/${todos.length} completed.${nudge !== undefined ? `\n${nudge}` : ""}`,
        isError: false,
      };
    },
  };
}

// The current todos rendered as a system-reminder the loop injects each turn (transient — not persisted into the
// transcript) so the goal stays in front of the model over many turns. Empty list → no reminder. `stale` (LESSON
// 059 P3): the loop hasn't seen a write_todos in a while though items are still open — nudge the model to make
// the list match reality instead of letting it rot (a rotten checklist steers worse than none).
export function renderTodoReminder(todos: TodoItem[], opts?: { stale?: boolean }): string {
  if (todos.length === 0) return "";
  const lines = todos.map((t) => {
    const box = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
    return `${box} ${t.status === "in_progress" ? t.activeForm : t.content}`;
  });
  return [
    "<system-reminder>",
    "Your current todo list (update it with write_todos as you make progress; mark items completed as you finish them):",
    ...lines,
    ...(opts?.stale === true
      ? [
          "This checklist has not moved in a while. Bring it back in line with reality — mark what is actually done, and prune items that no longer apply. A stale list steers you worse than none.",
        ]
      : []),
    "</system-reminder>",
  ].join("\n");
}

// Machine-readable todo carryover embedded in a session-memory digest. When the host folds the transcript span that
// held the last write_todos call, the digest replaces it as a PLAIN user message with no tool_calls — without this
// marker the next turn's history bootstrap would silently reset the checklist to empty mid-task. The host appends
// renderTodoCarryover to the digest; extractTodosFromHistory below reads it back as the fallback source.
const TODO_CARRYOVER_OPEN = "<todo-carryover>";
const TODO_CARRYOVER_CLOSE = "</todo-carryover>";

export function renderTodoCarryover(todos: TodoItem[]): string {
  if (todos.length === 0) return "";
  return `${TODO_CARRYOVER_OPEN}${JSON.stringify(todos)}${TODO_CARRYOVER_CLOSE}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      typeof p === "object" && p !== null && "text" in p && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : "",
    )
    .join("");
}

// undefined = no marker present (keep scanning); [] = a marker that failed to parse (treat as "no checklist", the
// same contract as an unparseable write_todos call).
function parseCarryover(text: string): TodoItem[] | undefined {
  const start = text.lastIndexOf(TODO_CARRYOVER_OPEN);
  if (start < 0) return undefined;
  const end = text.indexOf(TODO_CARRYOVER_CLOSE, start);
  if (end < 0) return undefined;
  try {
    return parseTodos(JSON.parse(text.slice(start + TODO_CARRYOVER_OPEN.length, end)));
  } catch {
    return [];
  }
}

// Seed the loop's todos from a prior run in the same conversation — scan the replayed history backwards for the LAST
// checklist state: a write_todos tool call, or a digest's todo-carryover marker (whichever came later wins, which the
// backward scan guarantees), so a continued conversation keeps its checklist even across a memory fold.
export function extractTodosFromHistory(messages: ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.type !== "function" || tc.function.name !== WRITE_TODOS_TOOL_NAME) continue;
        try {
          const args = JSON.parse(tc.function.arguments) as { todos?: unknown };
          return parseTodos(args.todos);
        } catch {
          return [];
        }
      }
    } else if (m?.role === "user") {
      const carried = parseCarryover(textOf(m.content));
      if (carried !== undefined) return carried;
    }
  }
  return [];
}
