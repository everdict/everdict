import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { previewFromEvents } from "./evidence-preview.js";

describe("previewFromEvents — the line that names a trace's work", () => {
  it("prefers the user's own words over everything else in the trace", () => {
    // Given a trace whose assistant answered and whose agent called a tool
    const events: TraceEvent[] = [
      { t: 0, kind: "span", name: "agent" },
      { t: 1, kind: "message", role: "assistant", text: "Sure, let me look." },
      { t: 2, kind: "tool_call", id: "t1", name: "bash", args: { command: "ls" } },
      { t: 3, kind: "message", role: "user", text: "analyze the failing payment logs" },
    ];
    // When the preview is derived / Then the ask wins, wherever it sits in the stream
    expect(previewFromEvents(events)).toBe("analyze the failing payment logs");
  });

  it("falls back through assistant → tool call → env action → recorded line", () => {
    // Given four traces, each missing every source above the one it carries
    const assistant: TraceEvent[] = [{ t: 0, kind: "message", role: "assistant", text: "done" }];
    const tool: TraceEvent[] = [{ t: 0, kind: "tool_call", id: "t1", name: "bash", args: { command: "pnpm test" } }];
    const action: TraceEvent[] = [{ t: 0, kind: "env_action", action: "session.open" }];
    const log: TraceEvent[] = [{ t: 0, kind: "log", stream: "stdout", text: "booting" }];
    // When each is derived / Then each falls to its own rung
    expect(previewFromEvents(assistant)).toBe("done");
    expect(previewFromEvents(tool)).toBe("bash pnpm test");
    expect(previewFromEvents(action)).toBe("session.open");
    expect(previewFromEvents(log)).toBe("booting");
  });

  it("names the span when the evidence is spans only (an OTLP arrival with no message)", () => {
    // Given a door arrival: spans projected to `span` events, no conversation at all
    const events: TraceEvent[] = [
      { t: 0, kind: "span", name: "checkout.submit" },
      { t: 5, kind: "llm_call", model: "gpt-5" },
    ];
    // When derived / Then the row is named by what ran rather than by its uuid
    expect(previewFromEvents(events)).toBe("checkout.submit");
  });

  it("prefers a real span over the assembled `invoke_agent` root, which names the producer again", () => {
    // Given an assembled spans body: the synthetic root plus the work underneath it
    const events: TraceEvent[] = [
      { t: 0, kind: "span", name: "invoke_agent default" },
      { t: 1, kind: "span", name: "checkout.submit" },
    ];
    // When derived / Then the row is not named after the agent every sibling row shares
    expect(previewFromEvents(events)).toBe("checkout.submit");
    // …but a trace holding nothing else still beats a bare uuid
    expect(previewFromEvents([{ t: 0, kind: "span", name: "invoke_agent default" }])).toBe("invoke_agent default");
  });

  it("collapses whitespace and truncates on a word boundary", () => {
    // Given a multi-line prompt longer than the cap
    const text = `first line\n\n   second line that keeps going and going ${"padding ".repeat(30)}`;
    const events: TraceEvent[] = [{ t: 0, kind: "message", role: "user", text }];
    // When derived
    const preview = previewFromEvents(events);
    // Then it is one line, within the cap, and does not end mid-word
    expect(preview).toBeDefined();
    expect(preview).not.toContain("\n");
    expect((preview ?? "").length).toBeLessThanOrEqual(141); // cap + the ellipsis
    expect(preview).toMatch(/^first line second line that keeps going/u);
    expect(preview?.endsWith("…")).toBe(true);
    // the cut lands between words: the last token is a whole word from the source, not a fragment of one
    expect((preview ?? "").slice(0, -1).split(" ").at(-1)).toBe("padding");
  });

  it("returns undefined rather than an empty string when nothing says anything", () => {
    // Given events that carry no phrase (and a whitespace-only message, which says nothing either)
    const events: TraceEvent[] = [
      { t: 0, kind: "message", role: "user", text: "   " },
      { t: 1, kind: "llm_call", model: "gpt-5" },
      { t: 2, kind: "tool_result", id: "t1", ok: true, output: "x" },
    ];
    // When derived / Then absence is explicit
    expect(previewFromEvents(events)).toBeUndefined();
    expect(previewFromEvents([])).toBeUndefined();
  });

  it("keeps a bare tool name when its arguments carry nothing readable", () => {
    // Given a tool call whose args are empty
    const events: TraceEvent[] = [{ t: 0, kind: "tool_call", id: "t1", name: "list_files", args: {} }];
    // When derived / Then the name still names the row
    expect(previewFromEvents(events)).toBe("list_files");
  });
});
