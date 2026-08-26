import type { GradeContext } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { assembleJudgeInput } from "./judge.js";
import { parseVerdict, previewJudge } from "./model-judge.js";

// ── The observation channel reaches the judge's PROMPT, three-valued (Track C) ───────────────────────
//
// The section is ALWAYS present: an absent channel is a stated fact the judge weighs — "no section" and
// "nothing changed" must never read alike. The prompt is asserted through previewJudge, which reuses
// buildPrompt verbatim, so what is pinned here is what the transport sends.

const base = (observations: GradeContext["observations"]): GradeContext => ({
  deadlineAt: Date.now() + 60_000,
  observations,
  case: { id: "c", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
});

describe("the judge sees the world's own account", () => {
  it("sampled deltas render as the INDEPENDENT OBSERVATIONS section, with their clock offsets", async () => {
    const input = await assembleJudgeInput(
      base({ kind: "sampled", deltas: [{ t: 1200, kind: "repo-diff", text: "+++ b/answer.txt" }] }),
    );
    expect(input.observations).toContain("[t=+1200ms repo-diff]");
    expect(input.observations).toContain("+++ b/answer.txt");
    const { prompt } = previewJudge(input);
    expect(prompt).toContain("INDEPENDENT OBSERVATIONS (sampled by the platform, not reported by the agent):");
    expect(prompt).toContain("+++ b/answer.txt");
  });

  it("a watched run in which nothing changed says so — a real answer, distinct from no channel", async () => {
    const input = await assembleJudgeInput(base({ kind: "sampled", deltas: [] }));
    expect(input.observations).toBe("The platform sampled the environment during the run and observed no changes.");
  });

  it("an absent channel is STATED with its reason, never silently missing from the prompt", async () => {
    const unsupported = await assembleJudgeInput(base({ kind: "unobserved", reason: "unsupported" }));
    expect(unsupported.observations).toContain("does not support platform sampling");
    const none = await assembleJudgeInput(base({ kind: "unobserved", reason: "no_environment" }));
    expect(none.observations).toContain("no live environment");
    const { prompt } = previewJudge(none);
    expect(prompt).toContain("No independent observation channel");
  });
});

describe("the judge is ASKED to weigh the observations, and its answer survives the parse", () => {
  // A channel the judge reads but never has to answer about is advisory — the verdict contract asks for
  // observation_consistency exactly when observations were SAMPLED, and the parse carries the answer onto
  // JudgeVerdict so the sealed judge execution holds it (Track C follow-through).
  // RED as of 6ec2a4b4: the instruction never mentioned observations and the parse dropped the field.
  it("a sampled channel extends the verdict instruction; an unobserved one does not", async () => {
    const sampled = await assembleJudgeInput(
      base({ kind: "sampled", deltas: [{ t: 5, kind: "repo-diff", text: "+++ b/x" }] }),
    );
    const { prompt } = previewJudge(sampled);
    expect(prompt).toContain('"observation_consistency"');
    const none = await assembleJudgeInput(base({ kind: "unobserved", reason: "no_environment" }));
    expect(previewJudge(none).prompt).not.toContain('"observation_consistency"');
  });

  it("the parsed verdict carries the judge's consistency answer", () => {
    const verdict = parseVerdict(
      '{"pass": true, "score": 1, "reason": "did the work", "observation_consistency": "divergent", "observation_note": "the trace claims a fix the diff does not contain"}',
    );
    expect(verdict.observationConsistency).toEqual({
      status: "divergent",
      note: "the trace claims a fix the diff does not contain",
    });
    // …and a verdict that says nothing about it carries nothing — never a fabricated "consistent".
    expect(parseVerdict('{"pass": true, "score": 1, "reason": "ok"}').observationConsistency).toBeUndefined();
  });
});
