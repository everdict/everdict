import { AppError } from "@everdict/contracts";
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
  it("otel: fetches with header injection and normalizes", async () => {
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

  it("mlflow: 3.x OTLP spans (snake_case AnyValue array) + header injection → normalized", async () => {
    // Real MLflow 3.x `/api/3.0/mlflow/traces/get` response: attributes are a {key,value:{string_value}} array (OTLP, snake_case).
    const body = {
      trace: {
        spans: [
          {
            name: "tool_call",
            start_time_unix_nano: 0,
            end_time_unix_nano: 1000000,
            attributes: [{ key: "tool.name", value: { string_value: "bash" } }],
          },
        ],
      },
    };
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    );
    const src = buildTraceSource({
      kind: "mlflow",
      endpoint: "http://mlflow:5000",
      headers: { authorization: "Basic c2s=" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    const trace = await src.fetch("tr-1");
    expect(trace.some((e) => e.kind === "tool_call")).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/3\.0\/mlflow\/traces\/get\?trace_id=tr-1$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Basic c2s=");
  });
});
