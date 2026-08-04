import { EVERDICT_ATTR, GEN_AI, TRACE_PLANE, type TraceEvent, type TraceSpan } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { eventsToSpans } from "./events-to-spans.js";
import { spansToEvents } from "./spans-to-events.js";

// Making spans the record is only affordable because judges keep reading events. That claim has exactly one
// test: assemble a harness's stream into spans, project it back, and get the same evidence. Anything that
// does not survive the round trip is evidence this change would silently rewrite.

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const T0 = Date.parse("2026-08-04T06:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function idFactory(): () => string {
  let n = 0;
  return () => (++n).toString(16).padStart(16, "0");
}

const STREAM: TraceEvent[] = [
  { t: T0, at: at(0), kind: "message", role: "user", text: "fix the flaky test" },
  { t: T0 + 100, at: at(100), kind: "tool_call", id: "tu_1", name: "Bash", args: { cmd: "pnpm test" } },
  { t: T0 + 900, at: at(900), kind: "tool_result", id: "tu_1", ok: true, output: "3 passed" },
  {
    t: T0 + 950,
    at: at(950),
    kind: "llm_call",
    model: "claude-opus-5",
    cost: { inputTokens: 120, outputTokens: 40, usd: 0.012 },
    latencyMs: 500,
  },
  { t: T0 + 1500, at: at(1500), kind: "log", stream: "stderr", text: "warning: retrying" },
  { t: T0 + 1600, at: at(1600), kind: "env_action", action: "repo.snapshot", detail: { files: 3 } },
  { t: T0 + 1700, at: at(1700), kind: "message", role: "assistant", text: "fixed the race" },
];

describe("assembling a harness stream into spans", () => {
  it("pairs a tool call with its result into ONE span whose length is the call's real duration", () => {
    const spans = eventsToSpans(STREAM, { traceId: TRACE_ID, agentName: "claude-code", newSpanId: idFactory() });
    const tool = spans?.find((s) => s.name === "execute_tool Bash");
    expect(tool).toBeDefined();
    expect(Date.parse(tool?.endedAt ?? "") - Date.parse(tool?.startedAt ?? "")).toBe(800);
    expect(tool?.attributes[GEN_AI.toolCallId]).toBe("tu_1");
    expect(tool?.status?.code).toBe("ok");
    // The result is NOT a span of its own — a result is not an interval.
    expect(spans?.some((s) => s.name === "tool_result")).toBe(false);
  });

  it("puts a log line where a point in time belongs — a span EVENT, not a sibling of the intervals", () => {
    const spans = eventsToSpans(STREAM, { traceId: TRACE_ID, agentName: "claude-code", newSpanId: idFactory() });
    const root = spans?.[0];
    expect(root?.name).toBe("invoke_agent claude-code");
    expect(root?.events).toEqual([
      {
        name: "log",
        at: at(1500),
        attributes: { [EVERDICT_ATTR.logStream]: "stderr", message: "warning: retrying" },
      },
    ]);
  });

  it("hangs every step under the root, and the root under the span that crossed the process boundary", () => {
    const spans = eventsToSpans(STREAM, {
      traceId: TRACE_ID,
      agentName: "claude-code",
      parentSpanId: "00f067aa0ba902b7",
      plane: TRACE_PLANE.agent,
      newSpanId: idFactory(),
    });
    const root = spans?.[0];
    expect(root?.parentSpanId).toBe("00f067aa0ba902b7");
    expect(spans?.slice(1).every((s) => s.parentSpanId === root?.spanId)).toBe(true);
    expect(spans?.every((s) => s.traceId === TRACE_ID)).toBe(true);
  });

  it("marks the whole assembly as inference — a tree we built is not a tree we were told", () => {
    const spans = eventsToSpans(STREAM, { traceId: TRACE_ID, agentName: "claude-code", newSpanId: idFactory() });
    expect(spans?.every((s) => s.attributes[EVERDICT_ATTR.assembled] === true)).toBe(true);
  });

  it("REFUSES a stream it cannot date rather than producing a tree that looks complete", () => {
    // The self-reported `trace:file` shape: step numbers, no absolute time. Partial assembly here would drop
    // exactly the steps it cannot place while still looking like the whole run.
    const undated: TraceEvent[] = [
      { t: 1, kind: "tool_call", id: "c1", name: "search", args: {} },
      { t: 2, kind: "tool_result", id: "c1", ok: true, output: "ok" },
    ];
    expect(eventsToSpans(undated, { traceId: TRACE_ID, agentName: "hermes", newSpanId: idFactory() })).toBeUndefined();
    // One undated event among dated ones is refused too — the tree would be silently short.
    const mixed: TraceEvent[] = [...STREAM, { t: 9, kind: "tool_call", id: "c9", name: "late", args: {} }];
    expect(eventsToSpans(mixed, { traceId: TRACE_ID, agentName: "hermes", newSpanId: idFactory() })).toBeUndefined();
  });
});

describe("projecting spans back to the events judges read", () => {
  it("returns the same evidence the harness emitted — the round trip judges depend on", () => {
    const spans = eventsToSpans(STREAM, { traceId: TRACE_ID, agentName: "claude-code", newSpanId: idFactory() });
    const events = spansToEvents(spans ?? []);
    const shape = (list: TraceEvent[]) =>
      list.map((e) => {
        switch (e.kind) {
          case "message":
            return `message:${e.role}:${e.text}`;
          case "tool_call":
            return `tool_call:${e.name}:${e.id}`;
          case "tool_result":
            return `tool_result:${e.id}:${e.ok}:${e.output}`;
          case "llm_call":
            return `llm_call:${e.model}:${e.cost?.inputTokens}/${e.cost?.outputTokens}/${e.cost?.usd}`;
          case "log":
            return `log:${e.stream}:${e.text}`;
          case "env_action":
            return `env_action:${e.action}`;
          default:
            return e.kind;
        }
      });

    const projected = shape(events);
    // The root `invoke_agent` span has no counterpart in the flat vocabulary — it projects as a structural
    // `span`, which is exactly what the union has always called a step it cannot classify.
    expect(projected.filter((s) => s !== "span")).toEqual([
      "message:user:fix the flaky test",
      "tool_call:Bash:tu_1",
      "tool_result:tu_1:true:3 passed",
      "llm_call:claude-opus-5:120/40/0.012",
      "log:stderr:warning: retrying", // a span event, re-ordered back into the stream where it happened
      "env_action:repo.snapshot",
      "message:assistant:fixed the race",
    ]);
  });

  it("keeps the tool call's real length, which the flat stream could only have inferred", () => {
    const spans = eventsToSpans(STREAM, { traceId: TRACE_ID, agentName: "claude-code", newSpanId: idFactory() });
    const call = spansToEvents(spans ?? []).find((e) => e.kind === "tool_call");
    expect(call?.durationMs).toBe(800);
    expect(call?.at).toBe(at(100));
  });

  it("projects a placement span back to the infra kind — every reader of infra keeps working", () => {
    // The record is an ordinary span with a real 23-second duration; the projection is the two facts the
    // old model could hold, plus the interval it could not.
    const placement: TraceSpan = {
      traceId: TRACE_ID,
      spanId: "00f067aa0ba902b7",
      name: "placement nomad",
      kind: "client",
      startedAt: at(0),
      endedAt: at(23_262),
      attributes: { [EVERDICT_ATTR.plane]: TRACE_PLANE.placement, "k8s.node.name": "in-heo-960XGK" },
      events: [
        { name: "leased", at: at(0) },
        { name: "Driver Failure", at: at(12_000) },
      ],
      status: { code: "ok" },
    };
    const events = spansToEvents([placement]);
    const infra = events.filter((e) => e.kind === "infra");
    expect(infra).toHaveLength(3); // the span itself + its two points
    expect(infra[0]).toMatchObject({ scope: "placement", node: "in-heo-960XGK", durationMs: 23_262 });
    expect(infra.map((e) => (e.kind === "infra" ? e.event : ""))).toEqual([
      "placement nomad",
      "leased",
      "Driver Failure",
    ]);
  });

  it("surfaces a failed span as an error event — the union has no status field to carry it", () => {
    const failed: TraceSpan = {
      traceId: TRACE_ID,
      spanId: "00f067aa0ba902b8",
      name: "execute_tool Bash",
      kind: "internal",
      startedAt: at(0),
      endedAt: at(500),
      attributes: { [GEN_AI.operationName]: "execute_tool", [GEN_AI.toolName]: "Bash" },
      status: { code: "error", message: "exit 127" },
    };
    const events = spansToEvents([failed]);
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ ok: false });
    expect(events.find((e) => e.kind === "error")).toMatchObject({ message: "exit 127" });
  });
});
