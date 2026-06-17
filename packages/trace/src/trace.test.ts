import { describe, expect, it } from "vitest";
import { parseMlflowTrace } from "./mlflow.js";
import { parseOtlpSpans } from "./otel.js";
import { type Span, spansToTraceEvents } from "./trace-source.js";

describe("spansToTraceEvents", () => {
  it("llm/tool/message 스팬을 TraceEvent 로 매핑한다", () => {
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
    expect(events[0]?.t).toBe(0); // 첫 스팬 기준 상대시간
  });
});

describe("parseOtlpSpans", () => {
  it("OTLP 속성 배열 + ns 시간을 정규화한다", () => {
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

describe("parseMlflowTrace", () => {
  it("MLflow trace 를 정규화한다", () => {
    const spans = parseMlflowTrace({
      spans: [
        {
          name: "tool",
          start_time_unix_nano: 2000000000,
          end_time_unix_nano: 2100000000,
          attributes: { "tool.name": "x" },
        },
      ],
    });
    expect(spans[0]?.startMs).toBe(2000);
    expect(spansToTraceEvents(spans).map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
  });
});
