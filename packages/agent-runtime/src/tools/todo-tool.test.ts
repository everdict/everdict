import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import {
  WRITE_TODOS_TOOL_NAME,
  buildTodoTool,
  extractTodosFromHistory,
  parseTodos,
  renderTodoCarryover,
  renderTodoReminder,
} from "./todo-tool.js";

const items = [
  { content: "Pull the scorecard", activeForm: "Pulling the scorecard", status: "completed" },
  { content: "Summarize failures", activeForm: "Summarizing failures", status: "in_progress" },
  { content: "Propose fixes", activeForm: "Proposing fixes", status: "pending" },
];

describe("parseTodos", () => {
  it("keeps valid items and drops malformed ones", () => {
    const raw = [...items, { content: "" }, { content: "x", status: "bogus" }, 42, null];
    const parsed = parseTodos(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual(items[0]);
  });
  it("defaults activeForm to content when absent", () => {
    expect(parseTodos([{ content: "Do X", status: "pending" }])[0]?.activeForm).toBe("Do X");
  });
});

describe("buildTodoTool", () => {
  it("is a native always-loaded tool that replaces the list via setTodos", async () => {
    let stored: unknown;
    const tool = buildTodoTool((t) => {
      stored = t;
    });
    expect(tool.name).toBe(WRITE_TODOS_TOOL_NAME);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.isMcp).toBeUndefined();
    const r = await tool.call({ todos: items }, {});
    expect(r.isError).toBe(false);
    expect(r.content).toContain("1/3 completed");
    expect(stored).toEqual(items);
  });
});

describe("renderTodoReminder", () => {
  it("renders a system-reminder with status boxes (active shows activeForm)", () => {
    const out = renderTodoReminder(parseTodos(items));
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("[x] Pull the scorecard");
    expect(out).toContain("[~] Summarizing failures"); // in_progress → activeForm
    expect(out).toContain("[ ] Propose fixes");
  });
  it("is empty for an empty list", () => {
    expect(renderTodoReminder([])).toBe("");
  });
});

describe("extractTodosFromHistory", () => {
  it("seeds from the last write_todos tool call in the replayed history", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "goal" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: WRITE_TODOS_TOOL_NAME, arguments: JSON.stringify({ todos: items }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ];
    expect(extractTodosFromHistory(messages)).toEqual(items);
  });
  it("returns [] when the history has no write_todos call", () => {
    expect(extractTodosFromHistory([{ role: "user", content: "hi" }])).toEqual([]);
  });

  it("seeds from a digest's todo-carryover marker when the write_todos call was folded away", () => {
    // Given a replayed history whose only checklist trace is the memory digest's carryover marker
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `[Conversation memory]\nA digest of earlier work.\n\n${renderTodoCarryover(parseTodos(items))}`,
      },
      { role: "user", content: "continue" },
      { role: "assistant", content: "on it" },
    ];
    // Then the checklist survives the fold instead of resetting to empty
    expect(extractTodosFromHistory(messages)).toEqual(items);
  });

  it("prefers a later write_todos call over an earlier digest carryover (backward scan)", () => {
    const later = parseTodos([{ content: "New plan", activeForm: "Planning", status: "pending" }]);
    const messages: ChatMessage[] = [
      { role: "user", content: renderTodoCarryover(parseTodos(items)) },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t2",
            type: "function",
            function: { name: WRITE_TODOS_TOOL_NAME, arguments: JSON.stringify({ todos: later }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "t2", content: "ok" },
    ];
    expect(extractTodosFromHistory(messages)).toEqual(later);
  });

  it("treats a malformed carryover as no checklist rather than scanning past it", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: renderTodoCarryover(parseTodos(items)) },
      { role: "user", content: "<todo-carryover>not json</todo-carryover>" },
    ];
    expect(extractTodosFromHistory(messages)).toEqual([]);
  });
});

describe("renderTodoCarryover", () => {
  it("is empty for an empty list", () => {
    expect(renderTodoCarryover([])).toBe("");
  });
});

describe("close-out nudge + stale reminder (LESSON 059 P3)", () => {
  it("invokes closeOutNudge with the incoming list BEFORE committing it, and appends what it returns", async () => {
    let committed: unknown;
    let sawPreviousUncommitted = false;
    const tool = buildTodoTool(
      (t) => {
        committed = t;
      },
      {
        closeOutNudge: (next) => {
          // The hook runs before setTodos — its closure can still read the PREVIOUS list.
          sawPreviousUncommitted = committed === undefined;
          return next.every((t) => t.status === "completed") ? "VERIFY-NUDGE" : undefined;
        },
      },
    );
    const allDone = items.map((t) => ({ ...t, status: "completed" }));
    const r = await tool.call({ todos: allDone }, {});
    expect(sawPreviousUncommitted).toBe(true);
    expect(r.content).toContain("3/3 completed");
    expect(r.content).toContain("VERIFY-NUDGE");
    // A write that leaves items open gets no nudge appended.
    const r2 = await tool.call({ todos: items }, {});
    expect(r2.content).not.toContain("VERIFY-NUDGE");
  });

  it("the stale flag appends a true-up line; a fresh list renders without it", () => {
    const fresh = renderTodoReminder(parseTodos(items));
    expect(fresh).not.toContain("has not moved");
    const stale = renderTodoReminder(parseTodos(items), { stale: true });
    expect(stale).toContain("has not moved");
    expect(stale).toContain("prune items that no longer apply");
  });
});
