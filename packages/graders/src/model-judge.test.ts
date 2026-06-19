import { AppError, type TraceEvent } from "@assay/core";
import { describe, expect, it, vi } from "vitest";
import { anthropicComplete, harnessComplete, modelJudge, openaiComplete, traceToText } from "./model-judge.js";

const TRACE: TraceEvent[] = [{ t: 0, kind: "llm_call", model: "m" }];

describe("modelJudge", () => {
  it("JudgeCompletion 의 JSON 판정을 파싱한다(앞뒤 산문 허용)", async () => {
    const complete = async () => 'sure: {"pass": true, "score": 0.9, "reason": "looks correct"} done';
    const v = await modelJudge(complete).judge({ task: "t", trace: TRACE });
    expect(v).toEqual({ pass: true, score: 0.9, reason: "looks correct" });
  });

  it("pass 누락 시 score 임계(0.5)로 도출, score 는 [0,1] 클램프", async () => {
    const v = await modelJudge(async () => '{"score": 1.4, "reason": "great"}').judge({ task: "t" });
    expect(v).toEqual({ pass: true, score: 1, reason: "great" });
    const low = await modelJudge(async () => '{"score": 0.2, "reason": "no"}').judge({ task: "t" });
    expect(low.pass).toBe(false);
  });

  it("JSON 이 없거나 형식 오류면 UpstreamError(502)", async () => {
    await expect(modelJudge(async () => "no json here").judge({ task: "t" })).rejects.toBeInstanceOf(AppError);
    await expect(modelJudge(async () => '{"reason":"x"}').judge({ task: "t" })).rejects.toBeInstanceOf(AppError);
  });

  it("프롬프트에 task/rubric/trace 가 포함된다", async () => {
    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({ task: "do X", rubric: "be correct", trace: TRACE });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("do X");
    expect(prompt).toContain("be correct");
    expect(prompt).toContain("llm_call");
  });
});

describe("anthropicComplete", () => {
  it("Messages API 를 호출하고 content[0].text 를 돌려준다", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ content: [{ text: "hi" }] }), { status: 200 })),
    );
    const complete = anthropicComplete({ apiKey: "k", model: "claude-opus-4-8", fetchImpl: fetchImpl as typeof fetch });
    expect(await complete("p")).toBe("hi");
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/v1\/messages$/);
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("non-2xx 는 UpstreamError 로 remap", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const complete = anthropicComplete({ apiKey: "k", model: "m", fetchImpl: fetchImpl as typeof fetch });
    await expect(complete("p")).rejects.toBeInstanceOf(AppError);
  });
});

describe("openaiComplete", () => {
  it("chat/completions 를 호출하고 choices[0].message.content 를 돌려준다(베이스 URL 적용)", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "verdict" } }] }), { status: 200 }),
      ),
    );
    const complete = openaiComplete({
      apiKey: "k",
      model: "gpt-5.4-mini",
      baseUrl: "http://litellm/v1",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(await complete("p")).toBe("verdict");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://litellm/v1/chat/completions");
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer k");
  });
});

describe("traceToText", () => {
  it("assistant 메시지를 모은다(없으면 전체 메시지)", () => {
    expect(
      traceToText([
        { t: 0, kind: "message", role: "user", text: "q" },
        { t: 1, kind: "llm_call", model: "m" },
        { t: 2, kind: "message", role: "assistant", text: "a1" },
        { t: 3, kind: "message", role: "assistant", text: "a2" },
      ]),
    ).toBe("a1\na2");
    // assistant 없으면 전체 메시지
    expect(traceToText([{ t: 0, kind: "message", role: "user", text: "only-user" }])).toBe("only-user");
  });
});

describe("harnessComplete", () => {
  it("디스패치된 에이전트 트레이스의 출력 텍스트를 verdict 로(modelJudge 와 결합)", async () => {
    const complete = harnessComplete({
      dispatch: async () => [
        { t: 0, kind: "message", role: "assistant", text: '{"pass":true,"score":1,"reason":"ok"}' },
      ],
    });
    const verdict = await modelJudge(complete).judge({ task: "t", trace: TRACE, rubric: "r" });
    expect(verdict).toEqual({ pass: true, score: 1, reason: "ok" });
  });
});
