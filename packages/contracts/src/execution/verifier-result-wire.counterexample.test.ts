import { describe, expect, it } from "vitest";
import { parseResult } from "../job-result-wire.js";
import { encodeVerifierResult, parseVerifierResult } from "./verifier-result-wire.js";

// ── THE VERIFIER'S RESULT NEEDS ITS OWN WIRE (arch-review 58 P0-verifier) ────────────────────────────
//
// The verifier entrypoint printed its scores through `encodeResult` — the CASE result sentinel — with a cast:
//
//     encodeResult({ caseId: "", harness: "", trace: [], scores } as never)
//
// and the other end, `parseResult`, runs `CaseResultSchema.parse()`. `snapshot` is required there, and a
// verifier has none to give: it did not run an environment, it judged one. So every verifier invocation that
// reached a managed lane died at the parse — deterministically, not as a race:
//
//     graders run · scores produced · envelope printed
//     → parseResult → "snapshot Required" → dispatch throws
//     → withVerifierPass records tests_pass: unmeasured
//
// Confirmed by executing the round trip at 26147830, not by reading it.
//
// The cast is how it compiled, and my own allowlist entry is how it stayed: `check-constructed-casts` listed
// this file with the reason "the shape is a wire artifact, not a CaseResult" — which is a statement OF the
// defect, written as its justification. An allowlist entry that describes why a value is wrong has recorded
// the bug rather than the exemption (rule `protocol` L2: every allowlist entry is a place the type failed to
// say it, and this one said it out loud).
//
// A verifier result is a different document from a case result. It gets a different sentinel, a different
// schema, and a parser that refuses the other one.
//
// RED as of 26147830, observed:
//   Cannot find module './verifier-result-wire.js'

const envelope = {
  runId: "r1",
  caseId: "c1",
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:workspace",
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
};

describe("[R58 COUNTEREXAMPLE] a verifier result crosses the process boundary intact", () => {
  it("round-trips through its own sentinel", () => {
    const parsed = parseVerifierResult(encodeVerifierResult(envelope));
    // The envelope's own fields survive exactly. The SCORES come back normalized (`ScoreSchema` preprocesses
    // through `normalizeScoreShape`), which is the same treatment the case wire gives them — asserting raw
    // equality here would be asserting that the shared score contract does not apply to this pipe.
    expect(parsed).toMatchObject({
      runId: envelope.runId,
      caseId: envelope.caseId,
      planDigest: envelope.planDigest,
      workspaceDigest: envelope.workspaceDigest,
    });
    expect(parsed.scores).toHaveLength(1);
    expect(parsed.scores[0]).toMatchObject({ graderId: "reward-file", metric: "tests_pass", value: 1 });
  });

  it("survives the noise a real job prints around it", () => {
    // The lane reads whole logs. Trace lines, a harness's stdout and the shell's own chatter sit around the
    // sentinel, and the last one wins — the same rule the case sentinel has.
    const logs = `installing\n${encodeVerifierResult(envelope)}\ncleanup done\n`;
    expect(parseVerifierResult(logs).scores).toHaveLength(1);
  });

  it("REFUSES a case result — the two documents are not interchangeable", () => {
    // The defect, inverted: a verifier envelope must not be readable as a case result, and a case result must
    // not be readable as a verifier one. Sharing a sentinel is what let a document with no snapshot be sent
    // down a pipe that requires one.
    const caseLine = `__EVERDICT_RESULT__ ${JSON.stringify({ caseId: "c1", harness: "h", trace: [], scores: [] })}`;
    expect(() => parseVerifierResult(caseLine)).toThrow(/verifier result/i);
  });

  it("is REFUSED BY the case parser — so a verifier can never be mistaken for a case", () => {
    expect(() => parseResult(encodeVerifierResult(envelope))).toThrow();
  });

  it("refuses an envelope missing the evidence that makes the verdict defensible", () => {
    // Not a formality: the plan digest says which procedure ran and the workspace digest says what it read.
    // An envelope without them is a number with no provenance, which is the state arch-review 57 closed.
    for (const missing of ["planDigest", "workspaceDigest", "runId", "caseId"] as const) {
      const partial: Record<string, unknown> = { ...envelope };
      delete partial[missing];
      expect(() => parseVerifierResult(`__EVERDICT_VERIFIER_RESULT__ ${JSON.stringify(partial)}`), missing).toThrow();
    }
  });

  it("refuses an envelope with no scores at all — an absence is not a measurement", () => {
    expect(() => parseVerifierResult(encodeVerifierResult({ ...envelope, scores: [] }))).toThrow(/score/i);
  });
});
