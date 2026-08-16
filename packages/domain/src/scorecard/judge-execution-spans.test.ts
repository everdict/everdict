import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { executionEvidenceTrace, judgeEvidenceEmitter, judgeExecutionSpans } from "./judge-execution-spans.js";

// Downstream report 1.1's trap: the judge's execution must be legible to a reader and INVISIBLE to the
// measurement plane — span kind, never llm_call, or the judge's tokens bill the judged agent.
describe("judgeExecutionSpans — the judgment plane in the vocabulary the measurement plane cannot misread", () => {
  const events: TraceEvent[] = [
    {
      t: 5,
      kind: "llm_call",
      model: "claude-opus-4-8",
      cost: { inputTokens: 900, outputTokens: 120, usd: 0.02 },
      latencyMs: 640,
    },
    { t: 6, kind: "message", role: "assistant", text: "PASS — the cart total matches." },
    { t: 7, kind: "span", name: "checkout", attributes: { step: 2 } },
    { t: 8, kind: "tool_call", id: "t1", name: "bash", args: {} },
  ];

  it("converts the model call and verdict to judge-named spans, renames structural spans, drops the transcript", () => {
    const spans = judgeExecutionSpans("quality", events);
    expect(spans.map((s) => s.kind)).toEqual(["span", "span", "span"]); // NOTHING is an llm_call
    expect(spans[0]).toMatchObject({
      kind: "span",
      name: "judge:quality:llm_call",
      attributes: { model: "claude-opus-4-8", inputTokens: 900, outputTokens: 120, usd: 0.02, latencyMs: 640 },
    });
    expect(spans[1]).toMatchObject({ name: "judge:quality:verdict" });
    // A dispatched judge's own span can never satisfy another judge's declared requires:[{kind:"span",name}].
    expect(spans[2]).toMatchObject({ name: "judge:quality:checkout" });
  });
});

// The emitter is the IDENTITY of the execution a sealed plane describes, because the ledger keeps the first
// seal per (runId, emitter). Anything two physical judge executions share here, they share permanently.
describe("judgeEvidenceEmitter — the plane's name says WHICH invocation produced the evidence", () => {
  it("narrows by invocation: no scope → judge only, a pass → judge#pass, a claim → judge#pass.generation.attempt", () => {
    expect(judgeEvidenceEmitter("quality")).toBe("judge:quality");
    expect(judgeEvidenceEmitter("quality", { passId: "pass-7" })).toBe("judge:quality#pass-7");
    expect(judgeEvidenceEmitter("quality", { passId: "pass-7", claim: { generation: 2, attempt: 3 } })).toBe(
      "judge:quality#pass-7.2.3",
    );
  });

  it("two invocations of ONE (pass, case, judge) get DISTINCT names — the retry the pass arbitrates on the claim", () => {
    // Given the same pass re-invoking one judge on one case: a Temporal activity retry (attempt 1 → 2) and a
    // later round (generation 0 → 1, whose attempt counter restarts at 1).
    const first = judgeEvidenceEmitter("quality", { passId: "pass-7", claim: { generation: 0, attempt: 1 } });
    const retry = judgeEvidenceEmitter("quality", { passId: "pass-7", claim: { generation: 0, attempt: 2 } });
    const nextRound = judgeEvidenceEmitter("quality", { passId: "pass-7", claim: { generation: 1, attempt: 1 } });
    // Then no two of them collide — a first-write-wins ledger refuses none of these seals, so the execution
    // whose verdict wins the claim is the execution whose evidence is on the record.
    expect(new Set([first, retry, nextRound]).size).toBe(3);
  });

  it("does not leak into the SPAN names the judge's evidence carries — the scope names the plane, not the spans", () => {
    // The spans attached to the judged case's trace are named from the judge id alone, so the projection that
    // keeps a prior judgment out of the next one's evidence (executionEvidenceTrace) strips an
    // invocation-scoped plane's spans exactly as it strips a bare one's — the emitter never reaches them.
    const spans = judgeExecutionSpans("quality", [{ t: 1, kind: "message", role: "assistant", text: "PASS" }]);
    expect(spans[0]).toMatchObject({ name: "judge:quality:verdict" });
    const trace: TraceEvent[] = [{ t: 0, kind: "message", role: "assistant", text: "the agent's own work" }, ...spans];
    expect(executionEvidenceTrace(trace)).toEqual([
      { t: 0, kind: "message", role: "assistant", text: "the agent's own work" },
    ]);
  });
});
