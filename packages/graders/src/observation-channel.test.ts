import type { GradeContext } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { assembleJudgeInput } from "./judge.js";
import { previewJudge } from "./model-judge.js";

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
