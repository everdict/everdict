import { describe, expect, it } from "vitest";
import { type AgentDraft, buildAgentDraftTools } from "./agent-draft-tool.js";
import type { AgentTryResult } from "./agent-try.js";

describe("craft_agent", () => {
  it("PATCHes the draft (only sent fields change, clear unsets) and streams every state to the host", async () => {
    // Given a draft with a task and a trigger
    const seen: AgentDraft[] = [];
    const [craft] = buildAgentDraftTools({
      initial: { id: "sentinel", task: "watch batches", triggers: [{ kinds: ["scorecard.completed"], filters: [] }] },
      onDraft: (draft) => seen.push(draft),
    });

    // When patching one field and clearing another
    await craft?.call({ description: "Watches scorecards." }, { abortSignal: new AbortController().signal });
    await craft?.call({ clear: ["task"] }, { abortSignal: new AbortController().signal });

    // Then untouched fields survived each patch and the cleared field is gone
    expect(seen[0]).toMatchObject({ id: "sentinel", task: "watch batches", description: "Watches scorecards." });
    expect(seen[1]?.task).toBeUndefined();
    expect(seen[1]?.description).toBe("Watches scorecards.");
    expect(seen[1]?.triggers).toHaveLength(1);
  });

  it("try_agent_draft shadow-runs the CURRENT draft (patches in the same turn are visible) and reports intents", async () => {
    const tried: AgentDraft[] = [];
    const result: AgentTryResult = {
      messages: [{ role: "assistant", content: "The batch failed on login cases." }],
      wouldHave: [{ name: "create_comment", input: { body: "…" } }],
      trace: [],
    };
    const tools = buildAgentDraftTools({
      initial: {},
      onDraft: () => {},
      tryDraft: async (draft) => {
        tried.push(draft);
        return result;
      },
    });
    const craft = tools.find((t) => t.name === "craft_agent");
    const tryTool = tools.find((t) => t.name === "try_agent_draft");

    await craft?.call({ task: "triage failures" }, { abortSignal: new AbortController().signal });
    const out = await tryTool?.call(
      { kind: "scorecard.completed", message: "Scorecard sc-1 succeeded", payload: { passRate: 0.5 } },
      { abortSignal: new AbortController().signal },
    );

    expect(tried[0]?.task).toBe("triage failures");
    expect(out?.content).toContain("create_comment");
    expect(out?.content).toContain("The batch failed on login cases.");
  });
});
