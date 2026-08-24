import type { CaseResult, RuntimeWorkRef, VerifierInvocation } from "@everdict/contracts";
import { CaseResultSchema, VerifierInvocationSchema, isMeasured } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import {
  type AgentHalfStore,
  agentHalfDigest,
  agentHalfKey,
  mergeVerifierPass,
  readAgentHalf,
  recoverStagedVerdict,
  stageAgentHalf,
  verifierVerdictKey,
} from "./agent-half.js";

// ── AN ADDRESS THAT ENCODES CONTENT IS NOT CONTENT AUTHENTICATION (arch-review 66 P1-provenance) ────
//
// Three separate holes, all the same mistake in different clothes: the coordinate LOOKED strong enough that
// nobody asked what actually verified it.
//
//   ① `agentHalfKey` carries the result digest — and nothing re-derived it. The S3 adapter writes with a
//      plain `PutObject` (no conditional create, no stored digest, same key overwrites), so any schema-valid
//      `CaseResult` sitting at that address was merged as the one the digest names. The `workspaceDigest`
//      check downstream passes when the trees really are the same, so a document with the same snapshot but
//      a different trace, different scores and different runtime provenance merged cleanly.
//   ② the staged-verdict guard was "present AND different → refuse", which ACCEPTS omission — and `work` and
//      `agentAttemptId` are optional on the schema, so the cheapest forgery is to say nothing.
//   ③ a receipt that came back `complete: false` still contributed its scores. `tests_pass` is a reserved
//      authority metric, so a verdict nobody could attribute was still deciding whether the case passed,
//      with `judgment: partial` as the label on a decision already made.
//
// Seen RED, in order:
//   another document at this coordinate was merged as the half its digest names: expected 'read' to be 'unknown'
//   a verdict naming no execution at all was merged as this handle's own: expected 'merged' to be 'unknown'
//   an unattributable verdict decided the case: expected 1 to be undefined

const RUN = "evd-run-r1";

const AGENT_HALF: CaseResult = CaseResultSchema.parse({
  caseId: "c1",
  harness: "cc@1.0.0",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "the agent ran" }],
  scores: [{ graderId: "steps", metric: "steps", value: 7 }],
  snapshot: { kind: "repo", diff: "diff --git a/x b/x", changedFiles: [], base: "b", headSha: "h" },
});
const DIGEST = agentHalfDigest(AGENT_HALF);

// The SAME workspace, a different execution: the trace, the scores and the harness all differ. This is what
// the digest-in-the-key was supposed to keep out and what the workspace check cannot see.
const IMPOSTOR: CaseResult = CaseResultSchema.parse({
  caseId: "c1",
  harness: "somebody-else@9",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "a different execution entirely" }],
  scores: [{ graderId: "steps", metric: "steps", value: 999 }],
  snapshot: AGENT_HALF.snapshot,
});

function store(): AgentHalfStore & { keys: () => string[] } {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key: string, data: Uint8Array) {
      objects.set(key, data);
      return key;
    },
    async get(key: string) {
      return objects.get(key);
    },
    async remove(key: string) {
      objects.delete(key);
    },
    keys: () => [...objects.keys()],
  };
}

const HANDLE: RuntimeWorkRef = {
  tenant: "acme",
  runId: RUN,
  externalJobId: "everdict-verify-c1",
  attemptId: `${RUN}#g2`,
  verifier: {
    planDigest: "sha256:plan",
    workspaceDigest: contentDigest(AGENT_HALF.snapshot),
    caseId: "c1",
    agentResultDigest: DIGEST,
    agentAttemptId: `${RUN}#g1`,
  },
} as unknown as RuntimeWorkRef;

describe("[R66 COUNTEREXAMPLE] a staged artifact is authenticated, not merely addressed", () => {
  it("REFUSES bytes that do not hash to the digest their key names", async () => {
    const artifacts = store();
    await stageAgentHalf(artifacts, "acme", RUN, AGENT_HALF);
    // The overwrite a plain PutObject permits: same key, different document, same workspace.
    await artifacts.put(
      agentHalfKey("acme", RUN, DIGEST),
      new TextEncoder().encode(JSON.stringify(IMPOSTOR)),
      "application/json",
    );

    const read = await readAgentHalf(artifacts, "acme", RUN, DIGEST);
    expect(read.kind, "another document at this coordinate was merged as the half its digest names").toBe("unknown");
    if (read.kind !== "unknown") return;
    expect(read.reason).toContain("hash to");
  });

  it("still READS the genuine half — the check verifies, it does not refuse everything", async () => {
    // The control. A guard nobody saw accept is as suspect as one nobody saw refuse.
    const artifacts = store();
    await stageAgentHalf(artifacts, "acme", RUN, AGENT_HALF);

    const read = await readAgentHalf(artifacts, "acme", RUN, DIGEST);
    expect(read.kind, "the digest check refuses the very bytes it was written to admit").toBe("read");
    if (read.kind !== "read") return;
    expect(read.result).toEqual(AGENT_HALF);
  });

  it("REFUSES a staged verdict that names no execution at all", async () => {
    // Omission, not disagreement. `work` and `agentAttemptId` are optional on the schema, so a document that
    // simply leaves them out is the cheapest thing to produce — and every clause of the old guard read
    // "present AND different", which such a document passes.
    const artifacts = store();
    await stageAgentHalf(artifacts, "acme", RUN, AGENT_HALF);
    // ⚠️ EVERYTHING THE HANDLE CAN CHECK, EXCEPT `work`. The first draft of this fixture omitted
    // `agentAttemptId` too, and the OLD guard caught it by accident on that clause — so the file went green
    // under its own neutralization and proved nothing. The realistic artifact satisfies every comparison
    // that is offered and simply declines to say which container it ran in.
    const naked: VerifierInvocation = VerifierInvocationSchema.parse({
      planDigest: "sha256:plan",
      workspaceDigest: contentDigest(AGENT_HALF.snapshot),
      scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
      agentAttemptId: `${RUN}#g1`,
    });
    await artifacts.put(
      verifierVerdictKey("acme", RUN, DIGEST, `${RUN}#g2`),
      new TextEncoder().encode(JSON.stringify(naked)),
      "application/json",
    );

    const recovered = await recoverStagedVerdict(artifacts, artifacts, "acme", RUN, HANDLE);
    expect(recovered.kind, "a verdict naming no execution at all was merged as this handle's own").toBe("unknown");
    if (recovered.kind !== "unknown") return;
    expect(recovered.reason).toContain("does not name the execution");
  });

  it("records an INCOMPLETE verdict's score as unmeasured rather than letting it decide", async () => {
    // `complete: false` means the receipt cannot say which container produced this verdict. The scores used
    // to ride in regardless, and `tests_pass` is a reserved authority metric — so an unattributable verdict
    // decided whether the case passed, under a `partial` label applied afterwards.
    const incomplete: VerifierInvocation = VerifierInvocationSchema.parse({
      planDigest: "sha256:plan",
      workspaceDigest: contentDigest(AGENT_HALF.snapshot),
      scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
    });

    const merged = mergeVerifierPass(AGENT_HALF, incomplete);

    expect(merged.verifier?.complete, "this fixture's receipt is complete, so the case below is untested").toBe(false);
    const verdict = merged.scores?.find((s) => s.metric === "tests_pass");
    expect(verdict, "the verdict vanished instead of being recorded as unmeasured").toBeDefined();
    if (!verdict) return;
    expect(isMeasured(verdict), "an unattributable verdict decided the case").toBe(false);
    // …and the receipt is still attached, so an operator can see WHY it was not counted.
    expect(merged.verifier).toBeDefined();
  });

  it("lets a COMPLETE verdict decide, unchanged", async () => {
    // The control for the policy: fail-closed must not mean fail-always.
    const complete: VerifierInvocation = VerifierInvocationSchema.parse({
      planDigest: "sha256:plan",
      workspaceDigest: contentDigest(AGENT_HALF.snapshot),
      scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
      agentAttemptId: `${RUN}#g1`,
      imageProvenance: { kind: "resolved", images: [{ ref: "v:1", digest: "sha256:i" }], by: "orchestrator" },
      work: {
        tenant: "acme",
        runId: RUN,
        externalJobId: "everdict-verify-c1",
        attemptId: `${RUN}#g2`,
        verifier: {
          planDigest: "sha256:plan",
          workspaceDigest: contentDigest(AGENT_HALF.snapshot),
          caseId: "c1",
          agentResultDigest: DIGEST,
          agentAttemptId: `${RUN}#g1`,
        },
      },
    });

    const merged = mergeVerifierPass(AGENT_HALF, complete);

    expect(merged.verifier?.complete, "this fixture is not complete, so it proves nothing about the policy").toBe(true);
    const verdict = merged.scores?.find((s) => s.metric === "tests_pass");
    expect(verdict && isMeasured(verdict), "a fully attributable verdict was refused").toBe(true);
  });
});
