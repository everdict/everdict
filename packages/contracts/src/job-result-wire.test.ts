import { describe, expect, it } from "vitest";
import type { CaseResult } from "./execution/eval-case.js";
import type { TraceEvent } from "./execution/trace.js";
import {
  EVENT_SENTINEL,
  RESULT_SENTINEL,
  encodeLiveEvent,
  encodeResult,
  extractLiveEvents,
  parseResult,
  stripSentinel,
} from "./job-result-wire.js";

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

describe("live-event wire format", () => {
  const EVENT: TraceEvent = { t: 1, kind: "message", role: "assistant", text: "working on it" };

  it("round-trips a TraceEvent through encode → extract, interleaved with harness output", () => {
    const stdout = `harness line\n${encodeLiveEvent(EVENT)}\nmore harness output\n`;
    expect(extractLiveEvents(stdout)).toEqual([EVENT]);
  });

  it("keeps event order across many lines and skips torn/invalid ones", () => {
    const second: TraceEvent = { t: 2, kind: "tool_call", id: "t1", name: "bash", args: { cmd: "ls" } };
    const torn = `${EVENT_SENTINEL}{"t":3,"kind":"mess`; // snapshot raced the writer mid-line
    const notAnEvent = `${EVENT_SENTINEL}{"hello":"world"}`;
    const stdout = [encodeLiveEvent(EVENT), torn, notAnEvent, encodeLiveEvent(second)].join("\n");
    expect(extractLiveEvents(stdout)).toEqual([EVENT, second]);
  });

  it("returns nothing when the log has no event lines", () => {
    expect(extractLiveEvents("plain progress\nno events here")).toEqual([]);
  });

  it("truncates an oversized event's text instead of emitting a broken line", () => {
    const big: TraceEvent = { t: 1, kind: "message", role: "assistant", text: "x".repeat(50_000) };
    const line = encodeLiveEvent(big);
    expect(line).toBeDefined();
    const [decoded] = extractLiveEvents(line ?? "");
    expect(decoded?.kind).toBe("message");
    if (decoded?.kind === "message") expect(decoded.text).toMatch(/\[truncated\]$/);
  });

  it("strips live-event lines from the human log view along with the result line", () => {
    const stdout = `progress 1\n${encodeLiveEvent(EVENT)}\nprogress 2\n${encodeResult(RESULT)}`;
    expect(stripSentinel(stdout)).toBe("progress 1\nprogress 2\n");
  });
});
