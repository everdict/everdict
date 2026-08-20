import type { GradeContext, JudgeSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { defaultJudgeRunner } from "./judge-runner.js";

// ── A LOST SEAL IS AN ANSWER, NOT A SILENCE (arch-review 58 follow-through) ──────────────────────────
//
// Sealing a judge's own execution onto the judged run's trajectory is best-effort BY CONTRACT — evidence,
// never lifecycle, because a trajectory-store hiccup must not lose a verdict that was really reached. That
// contract is right, and it was implemented as `.catch(() => {})` beneath a port that answered a bare
// `Score[]`. So the loss was invisible: a judgment whose account is gone came back shaped exactly like one
// whose account is on file.
//
// The runner answers a `JudgeInvocation` now, and this pins the half that lives in this app: the seal's
// outcome reaches the caller. The reader half — what a case's `EvidenceStatus` does with it — is pinned in
// `packages/domain/src/scorecard/judgment-evidence.counterexample.test.ts`, and the two are deliberately
// separate because they can break independently.
//
// Seen RED with `input.seal.outcome = …` removed, observed:
//   a trajectory store that refused the seal reported nothing: expected 'not_applicable' to be 'unsealed'

const spec = {
  id: "quality",
  kind: "model",
  provider: "anthropic",
  model: "claude-opus-5",
  rubric: "say PASS",
  inputs: ["trace"],
  tags: [],
} as unknown as JudgeSpec;

const ctx = {
  case: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60 },
  deadlineAt: Date.now() + 60_000,
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
} as unknown as GradeContext;

// A provider that answers a verdict, so the judge really executes and there is something to seal.
const provider = () =>
  Object.assign(
    async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"verdict":"pass","score":1,"reason":"ok"}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    {},
  ) as unknown as typeof fetch;

const runnerWith = (seal: () => Promise<void>) =>
  defaultJudgeRunner({
    secretsFor: async () => ({ ANTHROPIC_API_KEY: "sk-test" }),
    fetchImpl: provider(),
    trajectories: { seal },
  } as unknown as Parameters<typeof defaultJudgeRunner>[0]);

describe("[R58 COUNTEREXAMPLE] the judge runner reports whether its evidence landed", () => {
  it("answers UNSEALED when the trajectory store refuses the seal", async () => {
    const invocation = await runnerWith(async () => {
      throw new Error("trajectory store unavailable");
    }).run(spec, "acme", ctx, undefined, undefined, "evd-run-r1", undefined, undefined, "pass-1");

    // The verdict still stands — that is the contract, and breaking it would be the worse defect.
    expect(invocation.scores, "a store outage swallowed a verdict that was really reached").not.toHaveLength(0);
    expect(invocation.evidence, "a trajectory store that refused the seal reported nothing").toBe("unsealed");
  });

  it("answers SEALED when the evidence lands", async () => {
    const invocation = await runnerWith(async () => {}).run(
      spec,
      "acme",
      ctx,
      undefined,
      undefined,
      "evd-run-r1",
      undefined,
      undefined,
      "pass-1",
    );
    expect(invocation.evidence).toBe("sealed");
  });

  it("answers NOT_APPLICABLE when there is nothing to seal onto", async () => {
    // No run id: this judgment has no trajectory to be evidence ON. That is not a loss, and reporting it as
    // one would make every preview and every store-less deployment look like a degraded verdict.
    const invocation = await runnerWith(async () => {}).run(spec, "acme", ctx);
    expect(invocation.evidence).toBe("not_applicable");
  });
});
