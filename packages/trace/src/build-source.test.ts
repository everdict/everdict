import { AppError } from "@assay/core";
import { describe, expect, it, vi } from "vitest";
import { buildTraceSource } from "./build-source.js";

const otlp = {
  spans: [
    {
      name: "llm",
      startTimeUnixNano: "0",
      endTimeUnixNano: "1000000",
      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "m" } }],
    },
  ],
};

describe("buildTraceSource", () => {
  it("otel: 헤더 주입 + fetch 로 가져와 정규화", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(otlp), { status: 200 })),
    );
    const src = buildTraceSource({
      kind: "otel",
      endpoint: "http://jaeger:16686",
      headers: { authorization: "Bearer sk" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    const trace = await src.fetch("trace-1");
    expect(trace[0]?.kind).toBe("llm_call");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/traces\/trace-1$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk");
  });

  it("otel: non-2xx → UpstreamError", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) => Promise.resolve(new Response("no", { status: 403 })));
    const src = buildTraceSource({ kind: "otel", endpoint: "http://j", fetchImpl: fetchImpl as typeof fetch });
    await expect(src.fetch("t")).rejects.toBeInstanceOf(AppError);
  });

  it("mlflow: 헤더 주입 + 가져와 정규화", async () => {
    const body = {
      trace: {
        spans: [
          { name: "tool", start_time_unix_nano: 0, end_time_unix_nano: 1000000, attributes: { "tool.name": "bash" } },
        ],
      },
    };
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    );
    const src = buildTraceSource({
      kind: "mlflow",
      endpoint: "http://mlflow:5000",
      headers: { authorization: "Bearer sk" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    const trace = await src.fetch("run-1");
    expect(trace.some((e) => e.kind === "tool_call")).toBe(true);
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer sk");
  });
});
