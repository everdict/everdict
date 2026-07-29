import { describe, expect, it } from "vitest";
import { diffFileText } from "./diff.js";

const opsOf = (diff: ReturnType<typeof diffFileText>): string[] =>
  diff.hunks.flatMap((h) => h.lines.map((l) => `${l.op === "context" ? " " : l.op === "add" ? "+" : "-"}${l.text}`));

describe("diffFileText", () => {
  it("reports nothing to see when the two revisions are identical", () => {
    expect(diffFileText("same\n", "same\n")).toEqual({ hunks: [], added: 0, removed: 0, truncated: false });
  });

  it("shows a changed line as a removal followed by an addition, with its neighbours for context", () => {
    // Given one line rewritten in the middle of a document
    const before = "a\nb\nc\nd\ne\n";
    const after = "a\nb\nCHANGED\nd\ne\n";
    // When diffing
    const diff = diffFileText(before, after);
    // Then the change reads as -old/+new surrounded by context, and the counts match
    expect(opsOf(diff)).toEqual([" a", " b", "-c", "+CHANGED", " d", " e", " "]);
    expect({ added: diff.added, removed: diff.removed }).toEqual({ added: 1, removed: 1 });
  });

  it("carries 1-based line numbers on both sides so a viewer can align them", () => {
    const diff = diffFileText("a\nb\n", "a\nB\n");
    const changed = diff.hunks.flatMap((h) => h.lines).filter((l) => l.op !== "context");
    expect(changed).toEqual([
      { op: "remove", text: "b", beforeLine: 2 },
      { op: "add", text: "B", afterLine: 2 },
    ]);
  });

  it("drops untouched stretches, keeping only the edited passages", () => {
    // Given a long document edited in one place near the end
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line30", "line30 edited");
    // When diffing
    const diff = diffFileText(before, after);
    // Then the member gets that passage, not 40 lines to scroll — one hunk, context-sized
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines.length).toBeLessThanOrEqual(8);
    expect(opsOf(diff)).toContain("-line30");
    expect(opsOf(diff)).toContain("+line30 edited");
  });

  it("splits distant edits into separate hunks and anchors each at its own line", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line2", "line2 edited").replace("line35", "line35 edited");
    const diff = diffFileText(before, after);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]?.beforeStart).toBe(1);
    expect(diff.hunks[1]?.beforeStart).toBeGreaterThan(30);
  });

  it("handles pure insertion and pure deletion at the document edges", () => {
    // The trailing "" (the final newline) matches on both sides, so it stays context — an appended line reads as
    // one addition, not as a rewrite of the file's tail.
    expect(opsOf(diffFileText("a\n", "a\nb\n"))).toEqual([" a", "+b", " "]);
    expect(opsOf(diffFileText("a\nb\n", "a\n"))).toEqual([" a", "-b", " "]);
  });

  it("refuses to diff a file too large to compare instead of hanging on it", () => {
    // Given a file past the comparison cap (the LCS table is O(n·m))
    const huge = Array.from({ length: 20_001 }, (_, i) => `line${i}`).join("\n");
    // Then it says so, and the caller falls back to showing both contents
    expect(diffFileText(huge, `${huge}\nmore`)).toEqual({
      hunks: [],
      added: 0,
      removed: 0,
      truncated: true,
    });
  });
});
