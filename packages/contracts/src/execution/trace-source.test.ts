import { describe, expect, it } from "vitest";
import { snapshotFromEvidence } from "./trace-source.js";

// snapshotFromEvidence is the SSOT shared by the pull-ingest path (no harness run) and topology trace-delivery (a
// containerless service target whose agent offloaded its observation to its own store). It turns already-resolved
// evidence into the judge's browser snapshot; it never resolves refs itself (that happens upstream).
describe("snapshotFromEvidence", () => {
  it("synthesizes a browser snapshot from dom + inline screenshot", () => {
    expect(snapshotFromEvidence({ dom: "<page/>", screenshot: "YWJj", screenshotMediaType: "image/png" })).toEqual({
      kind: "browser",
      url: "",
      dom: "<page/>",
      screenshot: "YWJj",
      console: [],
    });
  });

  it("keeps an unresolved screenshotRef when the bytes could not be fetched", () => {
    expect(snapshotFromEvidence({ screenshotRef: "s3://bucket/shot.png" })).toEqual({
      kind: "browser",
      url: "",
      dom: "",
      screenshotRef: "s3://bucket/shot.png",
      console: [],
    });
  });

  it("returns undefined when there is no browser evidence (only a final answer / nothing) — caller keeps its own fallback", () => {
    expect(snapshotFromEvidence(undefined)).toBeUndefined();
    expect(snapshotFromEvidence({})).toBeUndefined();
    expect(snapshotFromEvidence({ finalAnswer: "done" })).toBeUndefined();
  });
});
