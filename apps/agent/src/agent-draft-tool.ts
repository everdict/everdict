import type { ToolDefinition } from "@everdict/agent-runtime";
import { AgentPermissionModeSchema, AgentTriggerSchema, TRIGGERABLE_EVENT_KINDS } from "@everdict/contracts";
import { z } from "zod";
import type { AgentTryEvent, AgentTryResult } from "./agent-try.js";

// Conversational agent crafting (docs/architecture/agent-automation.md B2/B3, the analysis-studio pattern):
// the crafting chat holds TOOLS that shape the draft on the member's canvas — `craft_agent` patches the draft
// (the web applies it live via the SSE `agent_draft` event) and `try_agent_draft` runs the CURRENT draft as a
// shadow activation so "does it actually work" is answered inside the same conversation. The crafted agent is
// pure DECLARATION (an AgentSpec) over the one shared agentic loop — crafting never builds a second runtime;
// the conversation IS the builder. Draft edits are unsaved + fully reversible → no HITL gate (the
// apply_view_config rationale); saving is the explicit `create_agent` mutation, which stays HITL-gated.

// The crafting vocabulary — the AgentSpec fields a conversation shapes. A PATCH: only provided fields change;
// `clear` unsets. (Unlike apply_view_config's reset-on-unset, drafts carry long texts — resend-everything
// would be hostile to multi-turn refinement.)
export const AgentDraftSchema = z
  .object({
    id: z.string().min(1).optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    task: z.string().optional(),
    triggers: z.array(AgentTriggerSchema).optional(),
    permissionMode: AgentPermissionModeSchema.optional(),
    model: z.string().optional(),
  })
  .strict();
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

const CLEARABLE_FIELDS = ["description", "instructions", "task", "triggers", "permissionMode", "model"] as const;

const CraftAgentInput = AgentDraftSchema.extend({
  clear: z.array(z.enum(CLEARABLE_FIELDS)).optional().describe("field names to unset"),
});

const TryDraftInput = z.object({
  kind: z.enum(TRIGGERABLE_EVENT_KINDS).describe("the platform-event kind to simulate"),
  message: z.string().min(1).describe("the event's one-line message, as the platform would render it"),
  subject: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
  payload: z.record(z.unknown()).optional().describe("pointer payload (ids/status/counts) trigger filters see"),
});

const STRING_PROP = { type: "string" };
const TRIGGER_ITEMS = {
  type: "object",
  properties: {
    kinds: { type: "array", items: { type: "string", enum: [...TRIGGERABLE_EVENT_KINDS] } },
    filters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: STRING_PROP,
          op: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte", "exists"] },
          value: { description: "string | number | boolean (omit for 'exists')" },
        },
        required: ["field", "op"],
      },
    },
  },
  required: ["kinds"],
};

export interface AgentDraftToolsOptions {
  initial: AgentDraft;
  // The host streams every applied patch to the web (SSE `agent_draft`) so the canvas updates live.
  onDraft: (draft: AgentDraft) => void;
  // Shadow-run the CURRENT draft against a simulated event (wired to runAgentTry). Absent → no try tool.
  tryDraft?: (draft: AgentDraft, event: AgentTryEvent) => Promise<AgentTryResult>;
}

// Both tools share one mutable draft closure, so a try inside the same turn sees the patches before it.
export function buildAgentDraftTools(opts: AgentDraftToolsOptions): ToolDefinition[] {
  let current: AgentDraft = { ...opts.initial };

  const craft: ToolDefinition = {
    name: "craft_agent",
    description:
      "Shape the agent draft on the user's crafting canvas — a PATCH: only the fields you send change (use " +
      "`clear` to unset). `task` = what the agent does when a trigger wakes it; `instructions` = standing " +
      "context for every turn; `triggers` = the platform-event subscriptions (kinds + payload filters like " +
      "passRate lt 1); `permissionMode` = how its mutations are approved (default=ask each, auto=ask guarded " +
      "only, bypass=never, plan). The canvas updates live and the user keeps manual control. To SAVE the draft " +
      "as a registered agent version, call create_agent with the full spec.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "agent id (kebab-case)" },
        description: STRING_PROP,
        instructions: STRING_PROP,
        task: STRING_PROP,
        triggers: { type: "array", items: TRIGGER_ITEMS },
        permissionMode: { type: "string", enum: ["default", "auto", "bypass", "plan"] },
        model: { type: "string", description: "registered model id override" },
        clear: { type: "array", items: { type: "string", enum: [...CLEARABLE_FIELDS] } },
      },
    },
    inputSchema: CraftAgentInput,
    isReadOnly: true, // the draft is unsaved + reversible — saving (create_agent) is the gated mutation
    call: async (input) => {
      const { clear, ...patch } = CraftAgentInput.parse(input);
      const next: AgentDraft = { ...current };
      for (const field of clear ?? []) delete next[field];
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (next as Record<string, unknown>)[key] = value;
      }
      current = next;
      opts.onDraft(current);
      return {
        content: `Applied — the crafting canvas now shows this draft:\n${JSON.stringify(current, null, 2)}`,
        isError: false,
      };
    },
  };

  if (!opts.tryDraft) return [craft];
  const tryDraft = opts.tryDraft;

  const tryTool: ToolDefinition = {
    name: "try_agent_draft",
    description:
      "SHADOW-RUN the current draft against a simulated platform event, right now: the draft's task/instructions " +
      "drive a real agent turn (read tools live on this workspace's data; mutations are captured as " +
      "would-have-done and denied — zero side effects). Returns what it did, what it answered, and which " +
      "mutations it WOULD have made. Use list_platform_events first to replay a REAL past event's kind/payload.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...TRIGGERABLE_EVENT_KINDS] },
        message: STRING_PROP,
        subject: {
          type: "object",
          properties: { type: STRING_PROP, id: STRING_PROP },
          required: ["type", "id"],
        },
        payload: { type: "object", description: "pointer payload the trigger filters see" },
      },
      required: ["kind", "message"],
    },
    inputSchema: TryDraftInput,
    isReadOnly: true, // shadow by construction — reads live, mutations denied
    call: async (input) => {
      const event = TryDraftInput.parse(input);
      const result = await tryDraft(current, {
        kind: event.kind,
        message: event.message,
        ...(event.subject !== undefined ? { subject: event.subject } : {}),
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
      });
      return { content: renderTryResult(result), isError: false };
    },
  };
  return [craft, tryTool];
}

// Compact rendering for the crafting model: the run's shape (tools touched), its final answer, and the
// captured mutation intents — enough to judge the draft without flooding the outer context.
function renderTryResult(result: AgentTryResult): string {
  const toolNames = result.messages.flatMap((m) => (m.toolCalls ?? []).map((t) => t.name));
  const finalAnswer = [...result.messages].reverse().find((m) => m.role === "assistant" && m.content.length > 0);
  const lines = [
    `Shadow run finished — ${result.messages.length} transcript entries.`,
    toolNames.length > 0 ? `Tools used: ${toolNames.join(", ")}` : "Tools used: none",
    result.wouldHave.length > 0
      ? `Mutations it WOULD have made:\n${result.wouldHave.map((w) => `- ${w.name} ${JSON.stringify(w.input)}`).join("\n")}`
      : "Mutations it would have made: none",
    finalAnswer ? `Final answer:\n${finalAnswer.content}` : "Final answer: (none produced)",
  ];
  return lines.join("\n\n");
}
