import { AppError } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { OtelTraceSource } from "./otel.js";

// Shape captured from a real Jaeger 1.62 query-API response — search (`GET /api/traces?service=…&tags=…`)
// also returns the same `{data:[{spans}]}` as id lookup and embeds the spans (collected in one request).
const JAEGER_BODY = {
  data: [
    {
      spans: [
        {
          operationName: "chat",
          startTime: 1781857437482972,
          duration: 1_000_000,
          tags: [
            { key: "gen_ai.request.model", value: "gpt-5.4-mini" },
            { key: "gen_ai.usage.input_tokens", value: 42 },
            { key: "gen_ai.usage.output_tokens", value: 7 },
          ],
        },
      ],
    },
  ],
};

describe("OtelTraceSource — tag correlation (Jaeger search)", () => {
  it("queries the service+tags(everdict.run_id) search URL and normalizes the embedded spans (pinned to the real 1.62 shape)", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify(JAEGER_BODY), { status: 200 })),
    );
    const src = new OtelTraceSource({
      endpoint: "http://jaeger:16686",
      correlate: "tag",
      service: "instrumented-cli",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const events = await src.fetch("everdict-run-1");

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/traces"); // search, not the id path
    expect(url.searchParams.get("service")).toBe("instrumented-cli"); // the required scope for a Jaeger search
    expect(url.searchParams.get("tags")).toBe(JSON.stringify({ "everdict.run_id": "everdict-run-1" }));
    expect(events.find((e) => e.kind === "llm_call")).toMatchObject({ model: "gpt-5.4-mini" });
  });

  it("tag not found (data=[]) → degrade to 0 events, service unset → explicit error (Jaeger parameter required)", async () => {
    const empty = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const src = new OtelTraceSource({
      endpoint: "http://jaeger:16686",
      correlate: "tag",
      service: "instrumented-cli",
      fetchImpl: empty as typeof fetch,
    });
    expect(await src.fetch("x")).toEqual([]);

    const none = new OtelTraceSource({ endpoint: "http://j", correlate: "tag", fetchImpl: empty as typeof fetch });
    await expect(none.fetch("x")).rejects.toThrow("service");
    await expect(none.fetch("x")).rejects.toBeInstanceOf(AppError);
  });

  it("correlate unset (id default) keeps the existing id path — no regression", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify(JAEGER_BODY), { status: 200 })),
    );
    const src = new OtelTraceSource({ endpoint: "http://jaeger:16686", fetchImpl: fetchImpl as typeof fetch });
    await src.fetch("abc123");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://jaeger:16686/api/traces/abc123");
  });
});
