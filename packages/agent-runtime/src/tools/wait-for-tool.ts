import type { EventSelectorFilter } from "@everdict/contracts";
import type { ToolDefinition } from "./definition.js";

export const WAIT_FOR_TOOL_NAME = "wait_for";

// What the agent asked to wait for. The kernel only carries it out of the run (AgentLoopResult.waitRequest) — the
// HOST owns the clock and the durability: it stamps the deadline and persists the intent on the conversation, so the
// watch survives a restart. Keeping time out of the kernel also keeps the loop deterministic under test.
export interface WaitRequest {
  kinds: string[];
  filters: EventSelectorFilter[];
  note: string;
  timeoutSeconds?: number;
}

function parseFilters(raw: unknown): { ok: true; value: EventSelectorFilter[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "'filters' must be an array." };
  const value: EventSelectorFilter[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, error: "each filter must be an object." };
    const { field, op, value: expected } = entry as { field?: unknown; op?: unknown; value?: unknown };
    if (typeof field !== "string" || field.length === 0) return { ok: false, error: "filter.field must be a string." };
    if (op !== "eq" && op !== "neq" && op !== "lt" && op !== "lte" && op !== "gt" && op !== "gte" && op !== "exists") {
      return { ok: false, error: `filter.op '${String(op)}' is not one of eq|neq|lt|lte|gt|gte|exists.` };
    }
    if (op === "exists") {
      value.push({ field, op });
      continue;
    }
    if (typeof expected !== "string" && typeof expected !== "number" && typeof expected !== "boolean") {
      return { ok: false, error: `filter.value is required for op '${op}'.` };
    }
    value.push({ field, op, value: expected });
  }
  return { ok: true, value };
}

// Waiting as a first-class move. Without it an agent that kicked off slow work has exactly two options — end the
// turn (which silently hands the job back to the member: "ask me again later") or poll in a tight loop (which the
// no-progress guard stops, and which burns tokens for nothing). This gives it the third: park the conversation on
// an event and be resumed here, with full context, when the world actually moves.
export function buildWaitForTool(kinds: readonly string[], submit: (request: WaitRequest) => void): ToolDefinition {
  return {
    name: WAIT_FOR_TOOL_NAME,
    description:
      "Wait for something to happen instead of ending your turn. Use this whenever you have started work that takes " +
      "time (a scorecard batch, a run, any job you kicked off) and you owe the member a report on how it turns out. " +
      "Your turn ends, but the conversation stays YOURS: when a matching event lands — or the timeout passes — you " +
      "are resumed right here with your full context and continue as if no time had passed. " +
      "NEVER close a turn with 'I'll check back later', 'let me know if you want an update', or a bare status line: " +
      "that hands your unfinished work back to the member, which is exactly what this tool exists to prevent. " +
      "Do not poll: read the status once to confirm the work is under way, then call this. On resume, report what " +
      "changed — and if the work is still not finished, you may wait again. " +
      "For work that emits NO platform event (an external system, a human you asked, wall-clock pacing), omit " +
      "`kinds` and set `timeout_seconds`: a pure timer — you sleep and are resumed after that long, with no event " +
      "able to wake you early.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        kinds: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: [...kinds] },
          description:
            "Event kinds that should wake you. Pick every outcome you care about (success AND failure). " +
            "Omit entirely (with timeout_seconds set) for a pure timer wait.",
        },
        filters: {
          type: "array",
          description:
            'Narrow the wake-up to the thing you started, e.g. [{"field":"id","op":"eq","value":"sc_123"}]. ' +
            "Without a filter ANY event of those kinds wakes you.",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte", "exists"] },
              value: { type: ["string", "number", "boolean"] },
            },
            required: ["field", "op"],
            additionalProperties: false,
          },
        },
        note: {
          type: "string",
          description:
            "One line on what you are waiting for and what you will do when it lands — shown to the member while " +
            "you wait, and replayed to you on resume.",
        },
        timeout_seconds: {
          type: "number",
          description:
            "Wake up anyway after this long if nothing lands (default 1 hour). Set it to roughly how long the work " +
            "should take — a job can die without ever emitting an event, and you must not wait forever.",
        },
      },
      required: ["note"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const { kinds: rawKinds, note, timeout_seconds: timeout } = input as Record<string, unknown>;
      if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
        return { content: "wait_for: 'timeout_seconds' must be a positive number.", isError: true };
      }
      // Timer-only wait (LESSON 059 P6, the Sleep reinterpretation): no kinds + an explicit timeout parks the
      // conversation on the clock alone. Omitting BOTH is refused — a wait that nothing can end is not a wait.
      const timerOnly = rawKinds === undefined || (Array.isArray(rawKinds) && rawKinds.length === 0);
      if (timerOnly && typeof timeout !== "number") {
        return {
          content: "wait_for: list the event kinds to wake on, or set 'timeout_seconds' for a pure timer wait.",
          isError: true,
        };
      }
      const selected: string[] = [];
      if (!timerOnly) {
        if (!Array.isArray(rawKinds)) {
          return { content: "wait_for: 'kinds' must be an array of event kinds.", isError: true };
        }
        for (const kind of rawKinds) {
          if (typeof kind !== "string" || !kinds.includes(kind)) {
            return { content: `wait_for: '${String(kind)}' is not a waitable event kind.`, isError: true };
          }
          selected.push(kind);
        }
      }
      if (typeof note !== "string" || note.trim().length === 0) {
        return { content: "wait_for: 'note' must say what you are waiting for.", isError: true };
      }
      const filters = parseFilters((input as { filters?: unknown }).filters);
      if (!filters.ok) return { content: `wait_for: ${filters.error}`, isError: true };
      submit({
        kinds: selected,
        filters: filters.value,
        note: note.trim(),
        ...(typeof timeout === "number" ? { timeoutSeconds: timeout } : {}),
      });
      return {
        content: timerOnly
          ? `Waiting ${String(timeout)}s. You will be resumed here when the timer passes.`
          : `Waiting for ${selected.join(", ")}. You will be resumed here when it happens.`,
        isError: false,
      };
    },
  };
}
