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

// The unit the dispatch asked about. Reading this wire without saying so is no longer possible — see the
// [R59] block at the bottom for why that is a required parameter rather than a companion check.
const EXPECTED = {
  runId: envelope.runId,
  caseId: envelope.caseId,
  planDigest: envelope.planDigest,
  workspaceDigest: envelope.workspaceDigest,
};

describe("[R58 COUNTEREXAMPLE] a verifier result crosses the process boundary intact", () => {
  it("round-trips through its own sentinel", () => {
    const parsed = parseVerifierResult(encodeVerifierResult(envelope), EXPECTED);
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
    expect(parseVerifierResult(logs, EXPECTED).scores).toHaveLength(1);
  });

  it("REFUSES a case result — the two documents are not interchangeable", () => {
    // The defect, inverted: a verifier envelope must not be readable as a case result, and a case result must
    // not be readable as a verifier one. Sharing a sentinel is what let a document with no snapshot be sent
    // down a pipe that requires one.
    const caseLine = `__EVERDICT_RESULT__ ${JSON.stringify({ caseId: "c1", harness: "h", trace: [], scores: [] })}`;
    expect(() => parseVerifierResult(caseLine, EXPECTED)).toThrow(/verifier result/i);
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
      expect(
        () => parseVerifierResult(`__EVERDICT_VERIFIER_RESULT__ ${JSON.stringify(partial)}`, EXPECTED),
        missing,
      ).toThrow();
    }
  });

  // ── AND WHOSE VERDICT IT IS, READ BACK RATHER THAN ASSUMED (arch-review 59 P1) ─────────────────────
  //
  // The envelope named the unit it judged, and both managed lanes took `.scores` off it and then stamped the
  // invocation's `planDigest`/`workspaceDigest` from what they had REQUESTED. So the provenance the lane
  // exists to produce was a copy of the request, and the container's own account was parsed and discarded one
  // expression later — `request copied into proof`, which rule `protocol` names as the shape that is not a
  // proof at all.
  //
  // The check is a REQUIRED PARAMETER of the parse rather than an `assertVerifierEnvelope` beside it, because
  // this repo has twice watched an optional companion go unwired on one of two lanes — most recently the K8s
  // verifier's missing activation, one review ago.
  //
  // Seen RED before the parameter existed: the call compiled with one argument and every mismatch below was
  // accepted, observed as
  //   a verifier that judged a different tree was adopted as this case's verdict: expected [Function] to throw
  it("REFUSES an answer about a different unit than the one dispatched", () => {
    for (const [field, wrong] of [
      ["runId", "r2"],
      ["caseId", "c2"],
      // The two a replay joins on. The container derives them from the same payload the lane sent, so a
      // disagreement means the ANSWER came from somewhere else — a previous case's sentinel still in the
      // logs, a reused alloc dir, a payload swapped before start — not that the container graded wrongly.
      // That narrower claim is the one this check earns, and the one the wire's own comment makes.
      ["planDigest", "sha256:other-plan"],
      ["workspaceDigest", "sha256:other-tree"],
    ] as const) {
      expect(
        () => parseVerifierResult(encodeVerifierResult({ ...envelope, [field]: wrong }), EXPECTED),
        `a verifier that judged a different ${field} was adopted as this case's verdict`,
      ).toThrow(/different unit/i);
    }
  });

  it("names WHICH coordinate disagreed, so an operator is not left diffing two opaque digests", () => {
    const err = (() => {
      try {
        parseVerifierResult(encodeVerifierResult({ ...envelope, workspaceDigest: "sha256:other" }), EXPECTED);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/workspaceDigest/);
  });

  it("refuses an envelope with no scores at all — an absence is not a measurement", () => {
    expect(() => parseVerifierResult(encodeVerifierResult({ ...envelope, scores: [] }), EXPECTED)).toThrow(/score/i);
  });
});
