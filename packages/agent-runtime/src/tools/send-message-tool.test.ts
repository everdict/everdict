import { describe, expect, it, vi } from "vitest";
import { buildSendMessageTool } from "./send-message-tool.js";

describe("buildSendMessageTool", () => {
  it("delivers to a known recipient and reports success", async () => {
    const deliver = vi.fn((_to: string, _message: string) => ({ ok: true }));
    const tool = buildSendMessageTool(deliver);
    const r = await tool.call({ to: "bg-1", message: "also check X" }, { selectedModel: "m" });
    expect(deliver).toHaveBeenCalledWith("bg-1", "also check X");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("bg-1");
  });

  it("surfaces a delivery failure as an error result (not a throw)", async () => {
    const deliver = vi.fn(() => ({ ok: false, error: 'No running background sub-agent "bg-9".' }));
    const tool = buildSendMessageTool(deliver);
    const r = await tool.call({ to: "bg-9", message: "hi" }, { selectedModel: "m" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("bg-9");
  });

  it("validates 'to' and 'message' before delivering", async () => {
    const deliver = vi.fn(() => ({ ok: true }));
    const tool = buildSendMessageTool(deliver);
    expect((await tool.call({ message: "hi" }, { selectedModel: "m" })).isError).toBe(true);
    expect((await tool.call({ to: "bg-1" }, { selectedModel: "m" })).isError).toBe(true);
    expect((await tool.call({ to: "bg-1", message: "  " }, { selectedModel: "m" })).isError).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });
});
