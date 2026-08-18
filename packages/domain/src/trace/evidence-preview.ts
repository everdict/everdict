import { GEN_AI_OPERATION, type TraceEvent } from "@everdict/contracts";

// ONE definition of "what was this trace asked to do" — the line that makes a browse row recognizable.
//
// A trace row identified only by its producer (the agent id, the harness id, the platform's generic root-span
// name) reads identically for every row: a screenful of `default <uuid>`, evidence that is present but
// unfindable, which is indistinguishable from evidence that is missing. The distinguishing thing is the WORK,
// and the work is in the evidence itself — the first thing that was asked, or failing that the first thing that
// was done. Both the owned ledger (`@everdict/application-control`, at seal) and the platform adapters
// (`@everdict/trace`, at list) derive it from here, so the two lists cannot drift into two different answers.
//
// Pure and total: no clocks, no I/O, never throws, and never returns an empty string (absence is `undefined`,
// per the no-silent-defaults rule — a caller must be able to tell "nothing to say" from "said nothing").

const DEFAULT_MAX = 140;

// Collapse the whitespace a transcript carries (newlines, indentation, tabs) into single spaces: a row is one
// line, and a multi-line prompt rendered raw either overflows it or comes out ragged.
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Truncate on a word boundary when there is one reasonably close to the cap — a cut mid-word reads as corruption.
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}

function clean(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const line = oneLine(text);
  return line === "" ? undefined : truncate(line, max);
}

// A tool call's arguments as a short hint — a trace whose first event is a tool call is identified by WHICH
// call with WHAT, not by the tool's name alone (three `bash` rows are still three identical rows).
function toolArgsHint(args: unknown): string | undefined {
  if (typeof args === "string") return clean(args, 60);
  if (args === null || args === undefined) return undefined;
  if (typeof args !== "object") return clean(String(args), 60);
  const values: string[] = [];
  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim() !== "") values.push(value);
    else if (typeof value === "number" || typeof value === "boolean") values.push(String(value));
    if (values.length >= 2) break;
  }
  return values.length === 0 ? undefined : clean(values.join(" "), 60);
}

// The assembled root span is named `invoke_agent <agent>` (`eventsToSpans`, the GenAI convention) — which is
// the PRODUCER again, the very thing that makes a page of rows read alike. It stays the last resort rather
// than a hard skip: a trace holding nothing else is still better named by its agent than by its uuid.
const AGENT_ROOT_PREFIX = `${GEN_AI_OPERATION.invokeAgent} `;

// The excerpt naming this trace's work, in falling order of how directly it answers "what was asked":
// the user's own words → the agent's answer → the first action taken → the first thing recorded.
export function previewFromEvents(events: readonly TraceEvent[], max: number = DEFAULT_MAX): string | undefined {
  let assistant: string | undefined;
  let tool: string | undefined;
  let action: string | undefined;
  let fallback: string | undefined;
  let agentRoot: string | undefined;
  for (const event of events) {
    switch (event.kind) {
      case "message":
        // The user's message wins outright — nothing else in a trace says what was wanted as plainly.
        if (event.role === "user") {
          const asked = clean(event.text, max);
          if (asked !== undefined) return asked;
        } else assistant ??= clean(event.text, max);
        break;
      case "tool_call": {
        if (tool !== undefined) break;
        const hint = toolArgsHint(event.args);
        tool = clean(hint !== undefined ? `${event.name} ${hint}` : event.name, max);
        break;
      }
      case "env_action":
        action ??= clean(event.action, max);
        break;
      case "span":
        if (event.name.startsWith(AGENT_ROOT_PREFIX)) agentRoot ??= clean(event.name, max);
        else fallback ??= clean(event.name, max);
        break;
      case "log":
        fallback ??= clean(event.text, max);
        break;
      case "error":
        fallback ??= clean(event.message, max);
        break;
      default:
        // llm_call/tool_result/artifact/infra carry no phrase a reader would recognize the run by.
        break;
    }
  }
  return assistant ?? tool ?? action ?? fallback ?? agentRoot;
}
