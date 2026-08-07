import type { ToolDefinition } from "./definition.js";

export const PRESENT_PLAN_TOOL_NAME = "present_plan";

// Plan mode (Claude Code's ExitPlanMode): while in plan mode the agent researches read-only and cannot make changes;
// it drafts a plan and presents it here for the host to approve. On approval the loop leaves plan mode and the agent
// proceeds. `submit` (the loop's closure) asks the host and returns whether it was approved.
// `expected_tools` (LESSON 059 P4, Claude Code's allowedPrompts reinterpreted): the plan DECLARES the write tools it
// will need, and approving the plan pre-authorizes them for the rest of the conversation — "plan then execute
// unattended" no longer stalls on a permission ask for every mutation the member just read about in the plan. The
// host decides what an approval actually grants (guarded/destructive actions still ask individually).
export function buildPresentPlanTool(
  submit: (plan: string, expectedTools: string[]) => Promise<boolean>,
): ToolDefinition {
  return {
    name: PRESENT_PLAN_TOOL_NAME,
    description:
      "You are in PLAN MODE: research with read-only tools, then present your plan here for approval — you cannot make " +
      "any changes until it is approved. Call this with your complete plan as markdown. List the WRITE tools the plan " +
      "will use in expected_tools: approval pre-authorizes those for this conversation, so you can execute the plan " +
      "without stopping at each step (destructive/guarded actions still ask individually). If it's approved you may " +
      "then act; if not, revise it and present again.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The complete plan, as markdown." },
        expected_tools: {
          type: "array",
          items: { type: "string" },
          description:
            "The write tools this plan will call (exact tool names). Approval pre-authorizes them for this " +
            "conversation — leave out anything you are not sure the plan needs.",
        },
      },
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
      const rawTools = (input as { expected_tools?: unknown }).expected_tools;
      const expectedTools = Array.isArray(rawTools)
        ? rawTools.filter((t): t is string => typeof t === "string" && t.length > 0)
        : [];
      const approved = await submit(plan, expectedTools);
      return approved
        ? { content: "Plan approved — plan mode is now off. Proceed with the plan.", isError: false }
        : { content: "Plan not approved — revise it based on any feedback and present it again.", isError: false };
    },
  };
}
