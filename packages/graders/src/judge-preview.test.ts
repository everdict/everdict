import type { EvidenceRequirement, GradeContext, TraceEvent } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { assessEvidence } from "./assess-evidence.js";
import { assembleJudgeInput } from "./judge.js";
import { modelJudge, previewJudge } from "./model-judge.js";

function promptCtx(trace: TraceEvent[], expected?: string): GradeContext {
  return {
    deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
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
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      case: { id: "c", env: { kind: "browser", startUrl: "u" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
      trace: [],
      snapshot: { kind: "browser", url: "u", dom: "<h1>Done</h1>", console: [] },
    };
    expect((await assembleJudgeInput(browser)).dom).toBe("<h1>Done</h1>");

    const prompt: GradeContext = { ...promptCtx([]), snapshot: { kind: "prompt", output: "final response" } };
    expect((await assembleJudgeInput(prompt)).response).toBe("final response");
  });

  // A repo-env case answers with FILES. Without this the judge saw only what the agent happened to say, so an agent
  // that wrote the deliverable and said nothing was evidence-identical to one that did nothing.
  it("maps a repo snapshot's diff as the produced-artifact evidence", async () => {
    const diff = "diff --git a/plan.md b/plan.md\n+++ b/plan.md\n+Day 1: fly ...";
    const repo: GradeContext = {
      deadlineAt: Date.now() + 60_000,
      case: {
        id: "c",
        env: { kind: "repo", source: { files: {} } },
        task: "write plan.md",
        graders: [],
        timeoutSec: 1,
        tags: [],
      },
      trace: [],
      snapshot: { kind: "repo", diff, changedFiles: ["plan.md"], headSha: "abc" },
    };
    const input = await assembleJudgeInput(repo);
    expect(input.diff).toBe(diff);
    expect(previewJudge(input).prompt).toContain("+Day 1: fly ...");

    // An empty diff is not evidence of anything — the agent produced nothing, and the slot stays absent rather than
    // handing the judge an empty section to read meaning into.
    const untouched: GradeContext = { ...repo, snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "abc" } };
    expect((await assembleJudgeInput(untouched)).diff).toBeUndefined();
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

  // gap 18: the VLM media type must be sniffed from the image's MAGIC BYTES, not the ref extension. The control-plane
  // artifact resolver puts base64 into snap.screenshot without a content-type, so a `*.png` ref would mislabel a JPEG.
  const browserShot = (screenshot: string, screenshotRef: string): GradeContext => ({
    deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
    case: { id: "c", env: { kind: "browser", startUrl: "u" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
    trace: [],
    snapshot: { kind: "browser", url: "u", dom: "", console: [], screenshotRef, screenshot },
  });

  it("labels a JPEG screenshot image/jpeg even when its ref ends in .png", async () => {
    const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD"; // JPEG SOI (FF D8 FF)
    const input = await assembleJudgeInput(browserShot(jpeg, "runs/x/shot.png"), { useScreenshot: true });
    expect(input.screenshot?.mediaType).toBe("image/jpeg"); // pre-fix: image/png (from the .png extension)
  });

  it("labels a PNG screenshot image/png (sniffed), and falls back to the extension for an unknown signature", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUg=="; // PNG signature (89 50 4E 47)
    expect(
      (await assembleJudgeInput(browserShot(png, "runs/x/shot"), { useScreenshot: true })).screenshot?.mediaType,
    ).toBe("image/png");
    // an unrecognized signature falls back to the ref extension (today's behavior).
    const unknown = Buffer.from("not an image at all").toString("base64");
    expect(
      (await assembleJudgeInput(browserShot(unknown, "runs/x/shot.jpg"), { useScreenshot: true })).screenshot
        ?.mediaType,
    ).toBe("image/jpeg");
  });
});

describe("custom evidence slots (mapping-authored → {<name>} placeholders)", () => {
  it("assembleJudgeInput carries GradeContext.evidence.custom into the input", async () => {
    const ctx: GradeContext = {
      ...promptCtx(TRACE),
      evidence: { custom: { confirmation_id: "R-42" } },
    };
    expect((await assembleJudgeInput(ctx)).custom).toEqual({ confirmation_id: "R-42" });
  });

  it("a custom template placeholder renders from the resolved slot; unbound identifiers stay verbatim", () => {
    const preview = previewJudge({
      task: "t",
      trace: TRACE,
      custom: { confirmation_id: "R-42" },
      promptTemplate: "ID: {confirmation_id} / RAW: {unbound_name} / {verdict_instruction}",
    });
    expect(preview.prompt).toContain("ID: R-42");
    expect(preview.prompt).toContain("RAW: {unbound_name}"); // never silently vanishes
    expect(preview.warnings.some((w) => w.includes("{unbound_name}"))).toBe(true);
    expect(preview.evidence.confirmation_id).toMatchObject({ present: true });
    expect(preview.evidence.unbound_name).toMatchObject({ present: false });
  });

  it("without a custom template, resolved custom slots get default-template EVIDENCE sections", () => {
    const preview = previewJudge({
      task: "t",
      trace: TRACE,
      custom: { run_log: "step1 ok\nstep2 ok" },
    });
    expect(preview.prompt).toContain("EVIDENCE run_log:\nstep1 ok\nstep2 ok");
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
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      case: { id: "c", env: { kind: "browser", startUrl: "u" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
      trace: [],
      snapshot: { kind: "browser", url: "u", dom: "<h1>ok</h1>", console: [] },
    };
    expect(assessEvidence([{ kind: "dom" }], browser).missing).toHaveLength(0);
    expect(assessEvidence([{ kind: "dom" }], promptCtx(TRACE)).missing).toHaveLength(1); // prompt snapshot has no dom
  });
});

// ── WHAT A JUDGE DECLARES IS WHAT A JUDGE IS SHOWN ───────────────────────────────────────────────────
//
// `inputs` used to be read for one value (`screenshot`) and `requires` was a preview-only annotation, so a
// registered judge's declaration barely touched the prompt its model actually saw.
describe("a judge's declaration shapes the input it is given", () => {
  const longTrace: TraceEvent[] = [
    ...Array.from(
      { length: 4_000 },
      (_, i): TraceEvent => ({ t: i, kind: "log", stream: "stdout", text: `noise ${i}` }),
    ),
    { t: 9_998, kind: "tool_call", id: "t", name: "submit_order", args: { id: "A-1" } },
    { t: 9_999, kind: "message", role: "assistant", text: "done" },
  ];

  it("hoists REQUIRED evidence into its own section, so trace truncation cannot swallow it", async () => {
    const requires: EvidenceRequirement[] = [{ kind: "tool_call", name: "submit_order" }];
    const input = await assembleJudgeInput(promptCtx(longTrace), { requires });
    const prompt = previewJudge(input).prompt;
    // The trace JSON is cut at the character budget and the required call sits past the cut…
    expect(JSON.stringify(longTrace).length).toBeGreaterThan(prompt.length);
    // …so without the hoist the judge would have been asked about a tool call it was never shown.
    expect(prompt).toContain("REQUIRED TOOL CALLS (submit_order)");
    expect(prompt).toContain("A-1");
  });

  it("omits the trace when the judge declared it does not want it", async () => {
    const withTrace = await assembleJudgeInput(promptCtx(TRACE), { modalities: ["screenshot"] });
    expect(withTrace.trace).toBeUndefined();
    expect(previewJudge(withTrace).prompt).not.toContain("the answer is 42");
    // …and an undeclared judge (an inline one) still sees everything the run carries.
    expect((await assembleJudgeInput(promptCtx(TRACE))).trace).toEqual(TRACE);
    expect((await assembleJudgeInput(promptCtx(TRACE), { modalities: ["trace"] })).trace).toEqual(TRACE);
  });

  it("a requirement the run does not satisfy is reported, and hoists nothing it does not have", async () => {
    const requires: EvidenceRequirement[] = [{ kind: "span", name: "checkout" }];
    const input = await assembleJudgeInput(promptCtx(TRACE), { requires });
    expect(input.requiredEvidence).toBeUndefined();
    expect(assessEvidence(requires, promptCtx(TRACE)).missing).toEqual(requires);
  });
});
