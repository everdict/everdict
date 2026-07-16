import type { GradeContext, TraceEvent } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { assembleJudgeInput } from "./judge.js";
import { modelJudge, previewJudge } from "./model-judge.js";

function promptCtx(trace: TraceEvent[], expected?: string): GradeContext {
  return {
    case: {
      id: "c",
      env: { kind: "prompt" },
      task: "do X",
      graders: [],
      timeoutSec: 1,
      tags: [],
      ...(expected ? { expected } : {}),
    },
    trace,
    snapshot: { kind: "prompt", output: "" },
  };
}

const TRACE: TraceEvent[] = [
  { t: 0, kind: "tool_call", id: "1", name: "search", args: { q: "x" } },
  { t: 1, kind: "message", role: "assistant", text: "the answer is 42" },
];

describe("assembleJudgeInput", () => {
  it("pulls task/trace from the context and expected from the case", async () => {
    const input = await assembleJudgeInput(promptCtx(TRACE, "42"));
    expect(input.task).toBe("do X");
    expect(input.trace).toEqual(TRACE);
    expect(input.expected).toBe("42");
  });

  it("maps a browser snapshot's dom and a prompt snapshot's output as evidence", async () => {
    const browser: GradeContext = {
      case: { id: "c", env: { kind: "browser", startUrl: "u" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
      trace: [],
      snapshot: { kind: "browser", url: "u", dom: "<h1>Done</h1>", console: [] },
    };
    expect((await assembleJudgeInput(browser)).dom).toBe("<h1>Done</h1>");

    const prompt: GradeContext = { ...promptCtx([]), snapshot: { kind: "prompt", output: "final response" } };
    expect((await assembleJudgeInput(prompt)).response).toBe("final response");
  });

  it("carries the judge's own rubric/criteria/promptTemplate knobs through", async () => {
    const input = await assembleJudgeInput(promptCtx(TRACE), {
      rubric: "be correct",
      criteria: [{ id: "acc", description: "accurate", weight: 1 }],
      promptTemplate: "{trace} {verdict_instruction}",
    });
    expect(input.rubric).toBe("be correct");
    expect(input.criteria).toHaveLength(1);
    expect(input.promptTemplate).toBe("{trace} {verdict_instruction}");
  });
});

describe("previewJudge", () => {
  it("renders a prompt byte-identical to what the transport receives (the preview never lies)", async () => {
    const ctx = promptCtx(TRACE, "42");
    const opts = { rubric: "be correct" };
    const input = await assembleJudgeInput(ctx, opts);

    // Capture the exact prompt the model transport would be sent.
    const complete = vi.fn((_p: string) => Promise.resolve('{"pass":true,"score":1,"reason":"ok"}'));
    await modelJudge(complete).judge(input);
    const transportPrompt = complete.mock.calls[0]?.[0] ?? "";

    expect(previewJudge(input).prompt).toBe(transportPrompt);
  });

  it("reports per-placeholder coverage: present flags, char counts, and truncation", () => {
    const big = "x".repeat(7000);
    const input = {
      task: "t",
      trace: [{ t: 0, kind: "message", role: "assistant", text: big }] as TraceEvent[],
      rubric: "r",
    };
    const { evidence } = previewJudge(input);

    expect(evidence.rubric?.present).toBe(true);
    expect(evidence.dom?.present).toBe(false);
    expect(evidence.final_answer?.present).toBe(true);
    expect(evidence.trace?.truncated).toBe(true); // > 6000 chars
    expect(evidence.trace?.chars).toBeGreaterThan(7000);
  });

  it("warns when a custom template references evidence the run does not carry", () => {
    const input = { task: "t", trace: TRACE, promptTemplate: "Judge the page: {dom}\n{verdict_instruction}" };
    const { warnings } = previewJudge(input);
    expect(warnings.some((w) => w.includes("{dom}"))).toBe(true);
  });

  it("warns on truncation of an oversized trace", () => {
    const big: TraceEvent[] = [{ t: 0, kind: "message", role: "user", text: "y".repeat(7000) }];
    const { warnings } = previewJudge({ task: "t", trace: big });
    expect(warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  it("flags a screenshot as present when the input carries image bytes", () => {
    const withImg = previewJudge({ task: "t", screenshot: { base64: "AAAA", mediaType: "image/png" } });
    expect(withImg.evidence.screenshot?.present).toBe(true);
    const without = previewJudge({ task: "t" });
    expect(without.evidence.screenshot?.present).toBe(false);
  });
});
