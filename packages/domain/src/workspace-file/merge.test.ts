import { describe, expect, it } from "vitest";
import { mergeThreeWay } from "./merge.js";

describe("mergeThreeWay", () => {
  it("keeps both authors' edits when they touched different parts of the file", () => {
    // Given a base both authors started from
    const base = "# Report\n\n## Summary\nold summary\n\n## Numbers\n42\n";
    // When one rewrites the summary and the other the numbers
    const ours = "# Report\n\n## Summary\nnew summary\n\n## Numbers\n42\n";
    const theirs = "# Report\n\n## Summary\nold summary\n\n## Numbers\n99\n";
    const result = mergeThreeWay(base, ours, theirs);
    // Then neither edit is lost and nothing needs a human
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toBe("# Report\n\n## Summary\nnew summary\n\n## Numbers\n99\n");
  });

  it("reports a conflict with both texts when the same lines were rewritten differently", () => {
    // Given the same line edited by both authors
    const base = "title: draft\nbody\n";
    const ours = "title: mine\nbody\n";
    const theirs = "title: theirs\nbody\n";
    // When merging
    const result = mergeThreeWay(base, ours, theirs);
    // Then the hunk is flagged with each side's text, and the document carries the markers inline
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      base: "title: draft",
      ours: "title: mine",
      theirs: "title: theirs",
    });
    expect(result.merged).toContain("<<<<<<< yours");
    expect(result.merged).toContain("title: mine");
    expect(result.merged).toContain("=======");
    expect(result.merged).toContain("title: theirs");
    expect(result.merged).toContain(">>>>>>> published");
  });

  it("treats an identical edit by both authors as agreement, not a conflict", () => {
    const result = mergeThreeWay("a\nb\n", "a\nB\n", "a\nB\n");
    expect(result).toEqual({ merged: "a\nB\n", conflicts: [] });
  });

  it("takes the other side when the incoming write changed nothing", () => {
    const result = mergeThreeWay("a\n", "a\n", "a\nappended\n");
    expect(result).toEqual({ merged: "a\nappended\n", conflicts: [] });
  });

  it("merges insertions made at different places by each author", () => {
    // Given two agents appending their own section to a shared report
    const base = "intro\n";
    const ours = "intro\nfrom the analyst\n";
    const theirs = "prelude\nintro\n";
    const result = mergeThreeWay(base, ours, theirs);
    // Then both survive, ordered around the line they both kept
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toBe("prelude\nintro\nfrom the analyst\n");
  });

  it("conflicts when one author deleted the lines the other rewrote", () => {
    const base = "keep\ndrop me\ntail\n";
    const ours = "keep\ntail\n"; // deleted
    const theirs = "keep\nrewritten\ntail\n"; // rewrote the same line
    const result = mergeThreeWay(base, ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.ours).toBe("");
    expect(result.conflicts[0]?.theirs).toBe("rewritten");
  });

  it("merges edits on ADJACENT lines without a conflict", () => {
    // Given a member rewriting one line while an agent rewrites the very next one — the everyday collision on a
    // shared report. Chunking by all-three-agree lines would call this a conflict; chunking by CHANGES does not.
    const base = "line1\nline2\nline3\n";
    const ours = "line1 by A\nline2\nline3\n";
    const theirs = "line1\nline2 by B\nline3\n";
    const result = mergeThreeWay(base, ours, theirs);
    expect(result).toEqual({ merged: "line1 by A\nline2 by B\nline3\n", conflicts: [] });
  });

  it("anchors the reported conflict at its line in the merged document", () => {
    const base = "1\n2\n3\n4\n";
    const ours = "1\n2\nours\n4\n";
    const theirs = "1\n2\ntheirs\n4\n";
    const result = mergeThreeWay(base, ours, theirs);
    const line = result.conflicts[0]?.line;
    expect(line).toBe(2);
    expect(result.merged.split("\n")[line ?? 0]).toBe("<<<<<<< yours");
  });
});
