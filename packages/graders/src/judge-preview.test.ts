import type { EvidenceRequirement, GradeContext, TraceEvent } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { assessEvidence } from "./assess-evidence.js";
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

describe("assessEvidence", () => {
  it("satisfies final_answer + tool_call requirements decidable from today's trace", () => {
    const a = assessEvidence(
      [{ kind: "final_answer" }, { kind: "tool_call", name: "search" }],
      promptCtx([
        { t: 0, kind: "tool_call", id: "1", name: "search", args: {} },
        { t: 1, kind: "message", role: "assistant", text: "42" },
      ]),
    );
    expect(a.missing).toHaveLength(0);
    expect(a.satisfied).toHaveLength(2);
  });

  it("reports a missing tool_call (wrong name) with a warning", () => {
    const a = assessEvidence([{ kind: "tool_call", name: "browse" }], promptCtx(TRACE));
    expect(a.missing).toEqual([{ kind: "tool_call", name: "browse" }]);
    expect(a.warnings.some((w) => w.includes("browse"))).toBe(true);
  });

  it("marks artifact/span requirements unmet when the trace has no such events", () => {
    const reqs: EvidenceRequirement[] = [
      { kind: "artifact", role: "report" },
      { kind: "span", name: "retriever" },
    ];
    const a = assessEvidence(reqs, promptCtx(TRACE));
    expect(a.missing).toHaveLength(2);
  });

  it("satisfies artifact/span requirements once the trace carries those events (ingest channel)", () => {
    const trace: TraceEvent[] = [
      { t: 0, kind: "artifact", name: "out.xlsx", ref: "s3://b/out.xlsx", role: "report" },
      { t: 1, kind: "span", name: "retriever" },
    ];
    const a = assessEvidence(
      [
        { kind: "artifact", role: "report" },
        { kind: "span", name: "retriever" },
      ],
      promptCtx(trace),
    );
    expect(a.missing).toHaveLength(0);
    expect(a.satisfied).toHaveLength(2);
    // A different role/name is still unmet.
    expect(assessEvidence([{ kind: "artifact", role: "other" }], promptCtx(trace)).missing).toHaveLength(1);
  });

  it("satisfies a dom requirement from a browser snapshot", () => {
    const browser: GradeContext = {
      case: { id: "c", env: { kind: "browser", startUrl: "u" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
      trace: [],
      snapshot: { kind: "browser", url: "u", dom: "<h1>ok</h1>", console: [] },
    };
    expect(assessEvidence([{ kind: "dom" }], browser).missing).toHaveLength(0);
    expect(assessEvidence([{ kind: "dom" }], promptCtx(TRACE)).missing).toHaveLength(1); // prompt snapshot has no dom
  });
});
