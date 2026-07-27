import { describe, expect, it } from "vitest";
import { buildViewConfigTool } from "./view-config-tool.js";

describe("apply_view_config", () => {
  it("hands the host the stored-form config (string keys only) and reports success", async () => {
    const applied: Record<string, string>[] = [];
    const tool = buildViewConfigTool((config) => applied.push(config));
    expect(tool.isReadOnly).toBe(true); // presentation-only, reversible — no HITL gate

    const result = await tool.call({ group: "day,harness", viz: "line", measure: "passRate", from: "2026-07-01" }, {});
    expect(result.isError).toBe(false);
    expect(applied).toEqual([{ group: "day,harness", viz: "line", measure: "passRate", from: "2026-07-01" }]);
  });

  it("rejects an unknown viz/measure at the tool boundary (the loop turns it into a correctable error)", async () => {
    const tool = buildViewConfigTool(() => {});
    await expect(tool.call({ viz: "pie" }, {})).rejects.toThrow();
  });
});
