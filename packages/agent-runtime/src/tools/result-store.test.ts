import { describe, expect, it } from "vitest";
import { READ_RESULT_TOOL_NAME, ResultStore, buildReadResultTool, offloadResult } from "./result-store.js";

describe("offloadResult + ResultStore", () => {
  it("stores the full content and returns a preview + id reference", () => {
    const store = new ResultStore();
    const full = "A".repeat(20_000);
    const ref = offloadResult(store, "result-1-0", full);
    expect(store.get("result-1-0")).toBe(full);
    expect(ref).toContain('stored as "result-1-0"');
    expect(ref).toContain("20000 chars");
    expect(ref).toContain(READ_RESULT_TOOL_NAME);
    // The reference carries only a bounded preview, not the whole payload.
    expect(ref.length).toBeLessThan(3_000);
  });

  it("repairs a surrogate pair split by the preview cut — the persisted preview must never carry a lone half", () => {
    const store = new ResultStore();
    // An emoji straddling the 2000-char preview boundary: the code-unit slice keeps only its high surrogate.
    const full = `${"x".repeat(1_999)}😀${"y".repeat(100)}`;
    const ref = offloadResult(store, "result-1-0", full);
    expect(ref).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(ref).toContain("x�"); // the cut half became U+FFFD, the rest of the preview is intact
    expect(store.get("result-1-0")).toBe(full); // the stored full content is untouched
  });
});

describe("buildReadResultTool", () => {
  const store = new ResultStore();
  store.put("r1", "0123456789".repeat(2)); // 20 chars
  const tool = buildReadResultTool(store);

  it("is a native always-loaded read-only tool", () => {
    expect(tool.name).toBe(READ_RESULT_TOOL_NAME);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.isReadOnly).toBe(true);
  });

  it("pages through a stored result via offset/limit", async () => {
    const first = await tool.call({ id: "r1", offset: 0, limit: 5 }, {});
    expect(first.isError).toBe(false);
    expect(first.content).toContain("01234");
    expect(first.content).toContain("more chars"); // 15 remain
    const rest = await tool.call({ id: "r1", offset: 5, limit: 100 }, {});
    expect(rest.content).toContain("56789");
    expect(rest.content).not.toContain("more chars"); // fully consumed
  });

  it("errors for an unknown id", async () => {
    const r = await tool.call({ id: "nope" }, {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain('No stored result with id "nope"');
  });

  it("repairs both window edges when a model-supplied offset lands mid-surrogate-pair", async () => {
    const s = new ResultStore();
    s.put("r2", "a😀b"); // 4 code units: a, high, low, b
    const t = buildReadResultTool(s);
    // The window ends between the emoji's halves…
    const head = await t.call({ id: "r2", offset: 0, limit: 2 }, {});
    expect(head.content.startsWith("a�")).toBe(true);
    // …and the next window starts between them: neither response carries a lone surrogate.
    const tail = await t.call({ id: "r2", offset: 2, limit: 2 }, {});
    expect(tail.content).toBe("�b");
  });
});
