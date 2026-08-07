import { describe, expect, it } from "vitest";
import { type WaitRequest, buildWaitForTool } from "./wait-for-tool.js";

const KINDS = ["scorecard.completed", "task.completed"] as const;

function harness() {
  const submitted: WaitRequest[] = [];
  const tool = buildWaitForTool(KINDS, (request) => {
    submitted.push(request);
  });
  return { tool, submitted };
}

describe("wait_for", () => {
  it("parks on the listed kinds with filters and an optional timeout", async () => {
    const { tool, submitted } = harness();
    const r = await tool.call(
      {
        kinds: ["scorecard.completed"],
        filters: [{ field: "id", op: "eq", value: "sc_1" }],
        note: "watching sc_1",
        timeout_seconds: 600,
      },
      {},
    );
    expect(r.isError).toBe(false);
    expect(submitted[0]).toEqual({
      kinds: ["scorecard.completed"],
      filters: [{ field: "id", op: "eq", value: "sc_1" }],
      note: "watching sc_1",
      timeoutSeconds: 600,
    });
  });

  it("accepts a TIMER-ONLY wait — no kinds, an explicit timeout — the self-pacing sleep (LESSON 059 P6)", async () => {
    const { tool, submitted } = harness();
    const r = await tool.call({ note: "check the external CI again in 5 minutes", timeout_seconds: 300 }, {});
    expect(r.isError).toBe(false);
    expect(r.content).toContain("300");
    // Empty kinds = nothing can match an event — only the deadline wakes the conversation.
    expect(submitted[0]).toEqual({
      kinds: [],
      filters: [],
      note: "check the external CI again in 5 minutes",
      timeoutSeconds: 300,
    });
  });

  it("refuses a wait that nothing can end (no kinds AND no timeout) and unknown kinds", async () => {
    const { tool, submitted } = harness();
    expect((await tool.call({ note: "…" }, {})).isError).toBe(true);
    expect((await tool.call({ kinds: [], note: "…" }, {})).isError).toBe(true);
    expect((await tool.call({ kinds: ["nope.kind"], note: "…" }, {})).isError).toBe(true);
    expect(submitted).toHaveLength(0);
  });
});
