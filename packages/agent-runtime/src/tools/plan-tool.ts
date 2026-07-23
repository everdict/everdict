import type { ToolDefinition } from "./definition.js";

export const PRESENT_PLAN_TOOL_NAME = "present_plan";

// Plan mode (Claude Code's ExitPlanMode): while in plan mode the agent researches read-only and cannot make changes;
// it drafts a plan and presents it here for the host to approve. On approval the loop leaves plan mode and the agent
// proceeds. `submit` (the loop's closure) asks the host and returns whether it was approved.
export function buildPresentPlanTool(submit: (plan: string) => Promise<boolean>): ToolDefinition {
  return {
    name: PRESENT_PLAN_TOOL_NAME,
    description:
      "You are in PLAN MODE: research with read-only tools, then present your plan here for approval — you cannot make " +
      "any changes until it is approved. Call this with your complete plan as markdown. If it's approved you may then " +
      "act; if not, revise it and present again.",
    parametersJsonSchema: {
      type: "object",
      properties: { plan: { type: "string", description: "The complete plan, as markdown." } },
      required: ["plan"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const plan = (input as { plan?: unknown }).plan;
      if (typeof plan !== "string" || plan.trim().length === 0) {
        return { content: "present_plan: 'plan' must be a non-empty markdown plan.", isError: true };
      }
      const approved = await submit(plan);
      return approved
        ? { content: "Plan approved — plan mode is now off. Proceed with the plan.", isError: false }
        : { content: "Plan not approved — revise it based on any feedback and present it again.", isError: false };
    },
  };
}
