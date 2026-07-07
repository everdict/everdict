import { describe, expect, it } from "vitest";
import { parseMlflowTrace } from "./mlflow.js";
import { parseJaegerSpans, parseOtlpSpans } from "./otel.js";
import { type Span, spansToTraceEvents } from "./trace-source.js";

describe("spansToTraceEvents", () => {
  it("maps llm/tool/message spans to TraceEvents", () => {
    const spans: Span[] = [
      {
        name: "chat",
        startMs: 1000,
        endMs: 1200,
        attrs: {
          "gen_ai.request.model": "claude-opus-4-8",
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 3,
          "gen_ai.usage.cost": 0.01,
        },
      },
      {
        name: "click",
        startMs: 1300,
        endMs: 1350,
        attrs: { "tool.name": "browser.click", "tool.call_id": "t1", "tool.result": "ok" },
      },
      { name: "final", startMs: 1400, endMs: 1400, attrs: { "message.content": "done" } },
    ];
    const events = spansToTraceEvents(spans);
    expect(events.map((e) => e.kind)).toEqual(["llm_call", "tool_call", "tool_result", "message"]);
    const llm = events[0];
    expect(llm?.kind === "llm_call" && llm.cost?.usd).toBe(0.01);
    expect(events[0]?.t).toBe(0); // relative time from the first span
  });

  it("maps MLflow native attributes (no gen_ai.*) to llm_call too — MLflow 3.x autolog trace", () => {
    // The shape real MLflow 3.11 puts on an LLM span (parseMlflowTrace unpacks kvlist → object).
    const spans: Span[] = [
      {
        name: "chat gpt-5.4-mini",
        startMs: 0,
        endMs: 8,
        attrs: {
          "mlflow.llm.model": "gpt-5.4-mini",
          "mlflow.chat.tokenUsage": { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
          "mlflow.llm.cost": { input_cost: 3.15e-5, output_cost: 3.15e-5, total_cost: 6.3e-5 },
        },
      },
    ];
    const e = spansToTraceEvents(spans)[0];
    expect(e?.kind).toBe("llm_call");
    expect(e?.kind === "llm_call" && e.model).toBe("gpt-5.4-mini");
    expect(e?.kind === "llm_call" && e.cost?.inputTokens).toBe(42);
    expect(e?.kind === "llm_call" && e.cost?.outputTokens).toBe(7);
    expect(e?.kind === "llm_call" && e.cost?.usd).toBe(6.3e-5);
  });
});

describe("parseOtlpSpans", () => {
  it("normalizes the OTLP attribute array + ns times", () => {
    const spans = parseOtlpSpans([
      {
        name: "chat",
        startTimeUnixNano: "1000000000", // 1000ms
        endTimeUnixNano: 1200000000,
        attributes: [
          { key: "gen_ai.request.model", value: { stringValue: "m1" } },
          { key: "gen_ai.usage.input_tokens", value: { intValue: "42" } },
        ],
      },
    ]);
    expect(spans[0]?.startMs).toBe(1000);
    expect(spans[0]?.attrs["gen_ai.request.model"]).toBe("m1");
    expect(spans[0]?.attrs["gen_ai.usage.input_tokens"]).toBe(42);
    // end-to-end: OTLP → TraceEvent
    expect(spansToTraceEvents(spans)[0]?.kind).toBe("llm_call");
  });
});

describe("parseJaegerSpans (Jaeger query shape)", () => {
  it("normalizes operationName / μs times / typed tags → TraceEvent", () => {
    // The spans[] shape of real Jaeger /api/traces/{id} (tag values already type-decoded).
    const spans = parseJaegerSpans([
      {
        operationName: "chat gpt-5.4-mini",
        startTime: 1781891481611118, // microseconds
        duration: 2000, // 2ms
        tags: [
          { key: "gen_ai.request.model", value: "gpt-5.4-mini" },
          { key: "gen_ai.usage.input_tokens", value: 42 },
          { key: "gen_ai.usage.output_tokens", value: 7 },
        ],
      },
    ]);
    expect(spans[0]?.name).toBe("chat gpt-5.4-mini");
    expect(spans[0]?.startMs).toBe(1781891481611); // μs→ms
    expect(spans[0]?.endMs).toBe(1781891481613); // +2ms
    expect(spans[0]?.attrs["gen_ai.usage.input_tokens"]).toBe(42);
    const e = spansToTraceEvents(spans)[0];
    expect(e?.kind === "llm_call" && e.model).toBe("gpt-5.4-mini");
    expect(e?.kind === "llm_call" && e.cost?.inputTokens).toBe(42);
  });
});

describe("parseMlflowTrace", () => {
  it("normalizes MLflow 3.x OTLP spans (attributes array)", () => {
    const spans = parseMlflowTrace({
      spans: [
        {
          name: "tool",
          start_time_unix_nano: 2000000000,
          end_time_unix_nano: 2100000000,
          attributes: [{ key: "tool.name", value: { string_value: "x" } }],
        },
      ],
    });
    expect(spans[0]?.startMs).toBe(2000);
    expect(spans[0]?.attrs["tool.name"]).toBe("x");
    expect(spansToTraceEvents(spans).map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
  });
});
