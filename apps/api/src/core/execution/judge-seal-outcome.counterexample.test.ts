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
//
// ── …AND EXACTLY WHICH EVIDENCE (arch-review 59 P1) ─────────────────────────────────────────────────
//
// The word was not enough, and the seal it reports on had been answering more than a word all along:
// `TrajectoryStore.seal` returns `TrajectoryMeta & { created: boolean }`, and `.then(() => true)` discarded
// every bit of it. `created` is false when a segment already holds this emitter — the trajectory keeps the
// FIRST per emitter — so this execution's events were DISCARDED and an earlier execution's stand. That was
// reported as `sealed`, and `judgmentsSealed` ("every judgment on this case can be re-read") stayed true
// while pointing a re-reader at somebody else's account.
//
// The fake in this very file is why it was never caught: it answered `Promise<void>`, which is more
// permissive than any real store, so the branch that reads the store's answer had no test to fail (rule
// `testing` — a fixture must reach the predicate, and one shaped unlike production does not).
//
// Seen RED before `created` was consumed, observed:
//   an earlier execution's evidence was reported as this judgment's own: expected 'sealed' to be 'superseded'

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
  observations: { kind: "unobserved", reason: "no_environment" },
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

// The store's REAL answer shape. `Promise<void>` here is what let the branch that reads it go untested.
type SealAnswer = {
  runId: string;
  tenant: string;
  source: "run";
  eventCount: number;
  sealedAt: string;
  created: boolean;
};
const meta = (created: boolean): SealAnswer => ({
  runId: "evd-run-r1",
  tenant: "acme",
  source: "run",
  eventCount: 1,
  sealedAt: "2026-08-21T00:00:00.000Z",
  created,
});

const runnerWith = (seal: (input: { emitter?: string }) => Promise<SealAnswer>) =>
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
    expect(invocation.evidence.status, "a trajectory store that refused the seal reported nothing").toBe("unsealed");
  });

  it("answers SEALED when the evidence lands, and says WHERE", async () => {
    const invocation = await runnerWith(async () => meta(true)).run(
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
    expect(invocation.evidence.status).toBe("sealed");
    // The coordinate, so a re-reader joins on identity instead of rebuilding `judge:<id>#<pass>…` from the
    // pieces — the downstream re-derivation rule `protocol` L3 forbids, and the reason `VerifierInvocation`
    // (this type's declared twin) carries its digests.
    expect(invocation.evidence, "the judgment plane cannot say which segment holds its account").toMatchObject({
      runId: "evd-run-r1",
      emitter: expect.stringContaining("judge:quality"),
    });
  });

  it("answers SUPERSEDED when a segment already held this emitter — not SEALED", async () => {
    // The arm that used to read as `sealed`. A trajectory keeps the FIRST segment per emitter, so this
    // execution's events were discarded and an earlier one's stand: the account on file is real, re-readable,
    // and NOT this judgment's. Reporting it as sealed is the difference between a missing claim and a wrong
    // one, and it silently swallowed the only signal that detects a slip in the emitter grammar.
    const invocation = await runnerWith(async () => meta(false)).run(
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
    expect(invocation.evidence.status, "an earlier execution's evidence was reported as this judgment's own").toBe(
      "superseded",
    );
    // The verdict still stands — best-effort by contract, in this arm as much as the others.
    expect(invocation.scores).not.toHaveLength(0);
  });

  it("answers NOT_APPLICABLE when there is nothing to seal onto", async () => {
    // No run id: this judgment has no trajectory to be evidence ON. That is not a loss, and reporting it as
    // one would make every preview and every store-less deployment look like a degraded verdict.
    const invocation = await runnerWith(async () => meta(true)).run(spec, "acme", ctx);
    expect(invocation.evidence.status).toBe("not_applicable");
  });
});
