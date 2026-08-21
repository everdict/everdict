import { describe, expect, it } from "vitest";
import { encodeResult } from "../job-result-wire.js";
import { adoptedResultFrom } from "./adopted-result.js";
import type { RuntimeWorkRef } from "./runtime-work-ref.js";
import { encodeVerifierResult } from "./verifier-result-wire.js";

// ── A HANDLE SAYS WHICH DOCUMENT ITS CONTAINER PRINTED (arch-review 59 P1) ──────────────────────────
//
// Adoption recovers an answer from work this process did not dispatch. Every managed lane wrote it as "fetch
// the logs, `parseResult`", which was right when there was one document a container could print.
//
// There are two. A verifier prints its own sentinel and its own schema — deliberately unreadable as a case
// result (arch-review 58) — and `verifierOperation` opens its row under the SAME `executionId` as the agent
// half, so for a standalone run its handle is in exactly the list boot recovery enumerates:
//
//     workHandlesFor("evd-run-<id>") → [ agent handle, verifier handle ]
//     → adoptWork(verifier handle) → parseResult → no sentinel → throw → { status: "unknown" }
//     → recovery: the first `unknown` is `retry_later` FOR THE WHOLE RUN
//
// So a run with a private verifier deferred on every boot, escalating after five attempts, while its agent's
// compute sat perfectly adoptable one handle away. Nothing was corrupted — which is why it would have been
// found by an operator rather than by a test.
//
// The repair is not a second adoption method. "Which protocol reads this container's answer" is a property of
// the WORK, so it rides the handle, and one reader consults it — because a third document added to one lane
// and forgotten in the other is the exact shape rule `backends` now forbids.
//
// Seen RED before the handle carried it, observed:
//   a verifier's verdict could not be adopted after a restart: could not find the agent result (sentinel).

const VERIFIER_WORK: RuntimeWorkRef = {
  tenant: "acme",
  runId: "evd-run-r1",
  externalJobId: "everdict-verify-c1-aaaa",
  verifier: { planDigest: "sha256:plan", workspaceDigest: "sha256:ws", caseId: "c1" },
};

const AGENT_WORK: RuntimeWorkRef = {
  tenant: "acme",
  runId: "evd-run-r1",
  externalJobId: "everdict-c1-bbbb",
};

const verifierLogs = (over: Record<string, unknown> = {}) =>
  `installing\n${encodeVerifierResult({
    runId: "evd-run-r1",
    caseId: "c1",
    planDigest: "sha256:plan",
    workspaceDigest: "sha256:ws",
    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
    ...over,
  } as never)}\ncleanup\n`;

describe("[R59 COUNTEREXAMPLE] a verifier's verdict is adoptable after a restart", () => {
  it("reads the verifier wire when the handle names a verifier", () => {
    const result = adoptedResultFrom(verifierLogs(), VERIFIER_WORK);
    expect(result.scores, "a verifier's verdict could not be adopted after a restart").toHaveLength(1);
    expect(result.scores[0]).toMatchObject({ metric: "tests_pass", value: 1 });
    expect(result.caseId).toBe("c1");
  });

  it("still reads the CASE wire for an ordinary handle", () => {
    // The other half of one reader: teaching it the second document must not cost it the first.
    const logs = encodeResult({
      caseId: "c1",
      harness: "agent@1",
      trace: [],
      scores: [],
      snapshot: { kind: "prompt", output: "done" },
    });
    expect(adoptedResultFrom(logs, AGENT_WORK).harness).toBe("agent@1");
  });

  it("REFUSES a verdict about a different unit, exactly as the in-line path does", () => {
    // Adoption is not a weaker door. A verdict recovered from a container nobody was waiting on gets the same
    // identity check as one read in-line — otherwise the restart path is where a foreign answer gets in.
    expect(
      () => adoptedResultFrom(verifierLogs({ workspaceDigest: "sha256:other" }), VERIFIER_WORK),
      "a restart adopted a verdict about a tree this case never produced",
    ).toThrow(/different unit/i);
  });

  it("does not read a verifier's logs as a case result, or the reverse", () => {
    // The two documents stay mutually unreadable, which is what stops the wrong parser being reached by
    // pointing the wrong handle at a container.
    expect(() => adoptedResultFrom(verifierLogs(), AGENT_WORK)).toThrow(/agent result/i);
    const caseLogs = encodeResult({
      caseId: "c1",
      harness: "agent@1",
      trace: [],
      scores: [],
      snapshot: { kind: "prompt", output: "" },
    });
    expect(() => adoptedResultFrom(caseLogs, VERIFIER_WORK)).toThrow(/verifier result/i);
  });
});
