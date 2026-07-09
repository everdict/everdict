import { AppError, type TraceEvent } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { anthropicComplete, harnessComplete, modelJudge, openaiComplete, traceToText } from "./model-judge.js";

const TRACE: TraceEvent[] = [{ t: 0, kind: "llm_call", model: "m" }];

describe("modelJudge", () => {
  it("parses the JSON verdict from a JudgeCompletion (surrounding prose allowed)", async () => {
    const complete = async () => 'sure: {"pass": true, "score": 0.9, "reason": "looks correct"} done';
    const v = await modelJudge(complete).judge({ task: "t", trace: TRACE });
    expect(v).toEqual({ pass: true, score: 0.9, reason: "looks correct" });
  });

  it("derives pass from the score threshold (0.5) when missing, clamps score to [0,1]", async () => {
    const v = await modelJudge(async () => '{"score": 1.4, "reason": "great"}').judge({ task: "t" });
    expect(v).toEqual({ pass: true, score: 1, reason: "great" });
    const low = await modelJudge(async () => '{"score": 0.2, "reason": "no"}').judge({ task: "t" });
    expect(low.pass).toBe(false);
  });

  it("UpstreamError (502) when JSON is missing or malformed", async () => {
    await expect(modelJudge(async () => "no json here").judge({ task: "t" })).rejects.toBeInstanceOf(AppError);
    await expect(modelJudge(async () => '{"reason":"x"}').judge({ task: "t" })).rejects.toBeInstanceOf(AppError);
  });

  it("includes task/rubric/trace in the prompt", async () => {
    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({ task: "do X", rubric: "be correct", trace: TRACE });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("do X");
    expect(prompt).toContain("be correct");
    expect(prompt).toContain("llm_call");
  });

  it("includes the final answer fully via a dedicated section even when it's at the end of the trace and the trace JSON is truncated", async () => {
    // Fill the front with more than 6000 chars (MAX_CHARS) so JSON.stringify(trace).slice(0, MAX) cuts off the final answer at the very end.
    const filler: TraceEvent[] = Array.from({ length: 200 }, (_, i) => ({
      t: i,
      kind: "message",
      role: "user",
      text: `step-${i}-${"x".repeat(40)}`,
    }));
    const FINAL = "FINAL_ANSWER_SENTINEL_9f3a: the task is complete and here is the produced result";
    const trace: TraceEvent[] = [...filler, { t: 999, kind: "message", role: "assistant", text: FINAL }];

    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({ task: "do X", trace });
    const prompt = complete.mock.calls[0]?.[0] ?? "";

    // Thanks to the dedicated AGENT FINAL ANSWER section, the final answer is fully present in the prompt (it would have been lost before the fix — regression).
    expect(prompt).toContain("AGENT FINAL ANSWER");
    expect(prompt).toContain(FINAL);
    // Regression guard: the trace JSON itself is still truncated and doesn't contain the final answer (proving it would have been lost without the dedicated section).
    const traceSection = prompt.slice(prompt.indexOf("EXECUTION TRACE"));
    expect(traceSection).not.toContain("FINAL_ANSWER_SENTINEL_9f3a");
  });

  it("the final answer is the last assistant message (not an intermediate assistant one)", async () => {
    const trace: TraceEvent[] = [
      { t: 0, kind: "message", role: "assistant", text: "interim-thought" },
      { t: 1, kind: "message", role: "user", text: "more" },
      { t: 2, kind: "message", role: "assistant", text: "the-real-final-answer" },
    ];
    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({ task: "t", trace });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    const section = prompt.slice(prompt.indexOf("AGENT FINAL ANSWER"), prompt.indexOf("EXECUTION TRACE"));
    expect(section).toContain("the-real-final-answer");
    expect(section).not.toContain("interim-thought");
  });

  const CRITERIA = [
    { id: "accuracy", description: "is it right", weight: 2 },
    { id: "style", description: "is it clean", weight: 1 },
  ];

  it("a custom promptTemplate replaces the default framing; placeholders expand to raw evidence + the verdict instruction", async () => {
    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({
      task: "do X",
      rubric: "be correct",
      trace: TRACE,
      promptTemplate: "Custom judge for {task}.\nRules: {rubric}\n{verdict_instruction}",
    });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("Custom judge for do X.");
    expect(prompt).toContain("Rules: be correct");
    expect(prompt).toContain("Respond with ONLY a JSON object");
    expect(prompt).not.toContain("You are a strict evaluation judge"); // default framing fully replaced
  });

  it("criteria: the default prompt lists every criterion and demands the multi-criteria verdict shape", async () => {
    const complete = vi.fn((_prompt: string) =>
      Promise.resolve(
        '{"criteria":{"accuracy":{"score":1,"pass":true,"reason":"a"},"style":{"score":1,"pass":true,"reason":"b"}},"pass":true,"score":1,"reason":"ok"}',
      ),
    );
    await modelJudge(complete).judge({ task: "t", trace: TRACE, criteria: CRITERIA });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("CRITERIA (score each):");
    expect(prompt).toContain("- accuracy (weight 2): is it right");
    expect(prompt).toContain("- style: is it clean"); // weight 1 → no weight annotation
    expect(prompt).toContain("scoring EVERY listed criterion");
  });

  it("criteria: parses per-criterion verdicts; overall = the model's verdict when present", async () => {
    const complete = async () =>
      '{"criteria":{"accuracy":{"score":0.9,"pass":true,"reason":"right"},"style":{"score":0.5,"pass":false,"reason":"messy"}},"pass":true,"score":0.8,"reason":"overall"}';
    const v = await modelJudge(complete).judge({ task: "t", criteria: CRITERIA });
    expect(v.score).toBe(0.8);
    expect(v.criteria?.accuracy).toEqual({ pass: true, score: 0.9, reason: "right" });
    expect(v.criteria?.style).toEqual({ pass: false, score: 0.5, reason: "messy" });
  });

  it("criteria: overall falls back to the weighted mean when the model gives no overall score", async () => {
    const complete = async () =>
      '{"criteria":{"accuracy":{"score":1,"pass":true,"reason":"a"},"style":{"score":0.1,"pass":false,"reason":"b"}}}';
    const v = await modelJudge(complete).judge({ task: "t", criteria: CRITERIA });
    expect(v.score).toBeCloseTo((2 * 1 + 1 * 0.1) / 3); // Σ(w·score)/Σw
    expect(v.pass).toBe(true); // 0.7 >= 0.5
    expect(v.reason).toContain("weighted mean");
  });

  it("criteria: a criterion missing from the verdict is an explicit UpstreamError (never a silent 0)", async () => {
    const complete = async () =>
      '{"criteria":{"accuracy":{"score":1,"pass":true,"reason":"a"}},"pass":true,"score":1,"reason":"r"}';
    await expect(modelJudge(complete).judge({ task: "t", criteria: CRITERIA })).rejects.toBeInstanceOf(AppError);
  });

  it("criteria: a per-criterion passThreshold re-decides that criterion's pass from its score", async () => {
    const strict = [{ id: "accuracy", description: "d", weight: 1, passThreshold: 0.95 }];
    const complete = async () =>
      '{"criteria":{"accuracy":{"score":0.9,"pass":true,"reason":"a"}},"pass":true,"score":0.9,"reason":"r"}';
    const v = await modelJudge(complete).judge({ task: "t", criteria: strict });
    expect(v.criteria?.accuracy?.pass).toBe(false); // 0.9 < 0.95 despite the model's pass:true
  });

  it("includes the case's expected output as reference evidence (default section + {expected} placeholder)", async () => {
    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({ task: "t", trace: TRACE, expected: "the reference answer" });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("EXPECTED OUTPUT (reference):");
    expect(prompt).toContain("the reference answer");

    const complete2 = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete2).judge({
      task: "t",
      expected: "ref",
      promptTemplate: "Reference: {expected}\n{verdict_instruction}",
    });
    expect(complete2.mock.calls[0]?.[0]).toContain("Reference: ref");
  });

  it("includes the result-channel final response in the prompt when the trace has no assistant answer (regression: it was dropped, leaving the judge without evidence)", async () => {
    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({ task: "t", trace: TRACE, response: "the produced result body" });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("AGENT FINAL RESPONSE");
    expect(prompt).toContain("the produced result body");
  });

  it("omits the response section when it duplicates the trace's final answer", async () => {
    const trace: TraceEvent[] = [{ t: 0, kind: "message", role: "assistant", text: "same answer" }];
    const complete = vi.fn((_prompt: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge({ task: "t", trace, response: "same answer" });
    const prompt = complete.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("AGENT FINAL ANSWER");
    expect(prompt).not.toContain("AGENT FINAL RESPONSE");
  });

  it("with a screenshot (VLM), passes the image to complete and notes it in the prompt", async () => {
    const complete = vi.fn((_prompt: string, _image?: { base64: string; mediaType: string }) =>
      Promise.resolve('{"pass":true,"score":1,"reason":"goal state shown"}'),
    );
    const screenshot = { base64: "AAAA", mediaType: "image/png" };
    const v = await modelJudge(complete).judge({ task: "show the remote form", screenshot });
    expect(v.pass).toBe(true);
    expect(complete.mock.calls[0]?.[1]).toEqual(screenshot); // image passed to transport
    expect(complete.mock.calls[0]?.[0]).toContain("SCREENSHOT"); // prompt notes the attached screenshot
  });
});

describe("anthropicComplete", () => {
  it("calls the Messages API and returns content[0].text", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ content: [{ text: "hi" }] }), { status: 200 })),
    );
    const complete = anthropicComplete({ apiKey: "k", model: "claude-opus-4-8", fetchImpl: fetchImpl as typeof fetch });
    expect(await complete("p")).toBe("hi");
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/v1\/messages$/);
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("remaps non-2xx to UpstreamError", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const complete = anthropicComplete({ apiKey: "k", model: "m", fetchImpl: fetchImpl as typeof fetch });
    await expect(complete("p")).rejects.toBeInstanceOf(AppError);
  });

  it("with an image, sends multimodal content (base64 image block)", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ content: [{ text: "hi" }] }), { status: 200 })),
    );
    const complete = anthropicComplete({ apiKey: "k", model: "claude-opus-4-8", fetchImpl: fetchImpl as typeof fetch });
    await complete("p", { base64: "B64", mediaType: "image/png" });
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "p" });
    expect(body.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "B64" },
    });
  });
});

describe("openaiComplete", () => {
  it("calls chat/completions and returns choices[0].message.content (base URL applied)", async () => {
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

  it("with an image, sends multimodal content (image_url data-URL) — incl. LiteLLM vision", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "v" } }] }), { status: 200 })),
    );
    const complete = openaiComplete({ apiKey: "k", model: "gpt-5.4-mini", fetchImpl: fetchImpl as typeof fetch });
    await complete("p", { base64: "B64", mediaType: "image/png" });
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "p" });
    expect(body.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,B64" },
    });
  });
});

describe("traceToText", () => {
  it("gathers assistant messages (all messages if none)", () => {
    expect(
      traceToText([
        { t: 0, kind: "message", role: "user", text: "q" },
        { t: 1, kind: "llm_call", model: "m" },
        { t: 2, kind: "message", role: "assistant", text: "a1" },
        { t: 3, kind: "message", role: "assistant", text: "a2" },
      ]),
    ).toBe("a1\na2");
    // all messages when no assistant
    expect(traceToText([{ t: 0, kind: "message", role: "user", text: "only-user" }])).toBe("only-user");
  });
});

describe("harnessComplete", () => {
  it("takes the dispatched agent trace's output text as the verdict (combined with modelJudge)", async () => {
    const complete = harnessComplete({
      dispatch: async () => [
        { t: 0, kind: "message", role: "assistant", text: '{"pass":true,"score":1,"reason":"ok"}' },
      ],
    });
    const verdict = await modelJudge(complete).judge({ task: "t", trace: TRACE, rubric: "r" });
    expect(verdict).toEqual({ pass: true, score: 1, reason: "ok" });
  });
});
