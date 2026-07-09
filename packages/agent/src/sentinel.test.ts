import type { CaseResult } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { RESULT_SENTINEL, encodeResult, parseResult, stripSentinel } from "./sentinel.js";

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "scripted@0.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
};

describe("sentinel wire format", () => {
  it("round-trips a CaseResult through encode → parse", () => {
    expect(parseResult(encodeResult(RESULT))).toEqual(RESULT);
  });

  it("decodes the result even when harness output precedes it on other lines", () => {
    const stdout = `some harness log\nmore output\n${encodeResult(RESULT)}\n`;
    expect(parseResult(stdout).caseId).toBe("c1");
  });

  it("takes the LAST sentinel when the log text happens to contain the marker earlier", () => {
    const stdout = `${RESULT_SENTINEL}{"fake":true}\n${encodeResult(RESULT)}`;
    expect(parseResult(stdout)).toEqual(RESULT);
  });

  it("throws when no sentinel is present (the agent crashed before emitting one)", () => {
    expect(() => parseResult("boom, no result")).toThrow(/sentinel/);
  });

  it("strips the machine result line from live logs, leaving the progress text", () => {
    const stdout = `progress line 1\nprogress line 2\n${encodeResult(RESULT)}`;
    expect(stripSentinel(stdout)).toBe("progress line 1\nprogress line 2\n");
  });

  it("leaves logs unchanged when there is no sentinel", () => {
    expect(stripSentinel("just logs")).toBe("just logs");
  });
});
