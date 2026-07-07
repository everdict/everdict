import { AppError } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { OtelTraceSource } from "./otel.js";

// 실제 Jaeger 1.62 query API 응답에서 캡처한 형태 — 검색(`GET /api/traces?service=…&tags=…`)도
// id 조회와 같은 `{data:[{spans}]}` 를 돌려주며 스팬을 동봉한다(요청 1회로 수집 완료).
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

describe("OtelTraceSource — tag 상관(Jaeger 검색)", () => {
  it("service+tags(everdict.run_id) 검색 URL 로 조회하고 동봉된 스팬을 정규화한다(실 1.62 형태 고정)", async () => {
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
    expect(url.pathname).toBe("/api/traces"); // id 경로가 아니라 검색
    expect(url.searchParams.get("service")).toBe("instrumented-cli"); // Jaeger 검색의 필수 범위
    expect(url.searchParams.get("tags")).toBe(JSON.stringify({ "everdict.run_id": "everdict-run-1" }));
    expect(events.find((e) => e.kind === "llm_call")).toMatchObject({ model: "gpt-5.4-mini" });
  });

  it("태그 미발견(data=[]) → 0건 degrade, service 미지정 → 명시 에러(Jaeger 파라미터 필수)", async () => {
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

  it("correlate 미지정(id 기본)은 기존 id 경로 그대로 — 무회귀", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify(JAEGER_BODY), { status: 200 })),
    );
    const src = new OtelTraceSource({ endpoint: "http://jaeger:16686", fetchImpl: fetchImpl as typeof fetch });
    await src.fetch("abc123");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://jaeger:16686/api/traces/abc123");
  });
});
