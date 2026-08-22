import type { CaseJob, CaseResult, VerifierInvocation } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { agentHalfKey, mergeVerifierPass, readAgentHalf } from "./agent-half.js";
import { withVerifierPass } from "./verifier-pass.js";

// ── THE FIRST PHASE IS DURABLE BEFORE THE SECOND EXISTS (arch-review 60 follow-through) ──────────────
//
// A case with a private verifier is two units, and the backend deletes the agent's Job as soon as it has
// parsed the result. So between the halves the agent's evidence lived in exactly one place — a local variable
// — and a control plane that died there left a recovery with a live verifier Job and nothing to attach its
// verdict to. arch-review 60 could only make the recovery SKIP that verdict; this is why.
//
// Staged before the second dispatch, keyed by the execution, so the recovery can read it back and finish the
// same merge. The ORDER is the whole property: staging after the verifier is dispatched closes nothing,
// because the window it exists for opens the moment that container is created.
//
// Seen RED with the staging removed, observed:
//   the agent's half was never on file when the verifier was dispatched: expected [] to deeply equal
//   [ 'stage', 'dispatch-verifier' ]

const JOB = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "repo", source: { path: "/app" } },
      timeoutSec: 60,
      tags: [],
      // A grader whose config is verifier-private is what makes this a two-phase case at all.
      graders: [{ id: "reward-file", config: { files: { "tests/t.py": "assert 1" } } }],
    },
  }) as unknown as CaseJob;

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "agent@1",
  trace: [],
  scores: [],
  // A REPO snapshot: only a file tree can be reconstituted in a second container, so a prompt case never
  // reaches the verifier at all and would make every assertion here vacuous (rule `testing`).
  snapshot: { kind: "repo", diff: "d", changedFiles: ["a.py"], headSha: "sha" },
} as unknown as CaseResult;

describe("[R60 COUNTEREXAMPLE] the agent's half is staged before the verifier is dispatched", () => {
  it("stages it FIRST, and under the key the recovery computes", async () => {
    const order: string[] = [];
    const written = new Map<string, Uint8Array>();
    const halves = {
      put: async (key: string, data: Uint8Array) => {
        order.push("stage");
        written.set(key, data);
        return "ref";
      },
      get: async (key: string) => written.get(key),
    };

    await withVerifierPass(JOB(), {
      dispatch: async () => RESULT,
      dispatchVerifier: async (): Promise<VerifierInvocation> => {
        order.push("dispatch-verifier");
        return {
          planDigest: "sha256:plan",
          workspaceDigest: contentDigest(RESULT.snapshot),
          scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        } as unknown as VerifierInvocation;
      },
      agentHalves: halves,
    });

    expect(order, "the agent's half was never on file when the verifier was dispatched").toEqual([
      "stage",
      "dispatch-verifier",
    ]);
    // …under the key the RECOVERY derives from a work handle, which is the only coordinate it holds.
    // Keyed by the WORKSPACE too, so a second attempt of the same logical execution cannot overwrite this
    // one's half (arch-review 61 P1-high).
    const digest = contentDigest(RESULT.snapshot);
    expect([...written.keys()]).toEqual([agentHalfKey("acme", "evd-run-r1", digest)]);

    // …and it reads back as the agent's own result, through the contract rather than a cast.
    const half = await readAgentHalf(halves, "acme", "evd-run-r1", digest);
    expect(half.kind).toBe("read");
    expect(half.kind === "read" && half.result.harness).toBe("agent@1");
  });

  it("cannot be OVERWRITTEN by another attempt of the same execution", () => {
    // `runId` is the LOGICAL execution — the same across a retry, a speculative second attempt and a
    // re-lease — and an object store's write replaces what is at a key. Two attempts staging to one object
    // meant a recovery could merge attempt A's VERDICT onto attempt B's EVIDENCE: a case that never happened,
    // assembled from two that did, with no seam a downstream reader can see (arch-review 61 P1-high).
    const a = contentDigest({ kind: "repo", diff: "A", changedFiles: ["a"], headSha: "sha-a" });
    const b = contentDigest({ kind: "repo", diff: "B", changedFiles: ["b"], headSha: "sha-b" });
    expect(a, "two different trees digested the same, so this test proves nothing").not.toBe(b);
    expect(agentHalfKey("acme", "evd-run-r1", a), "two attempts of one execution stage to the same object").not.toBe(
      agentHalfKey("acme", "evd-run-r1", b),
    );
  });

  it("REFUSES to merge a verdict produced against a different workspace", () => {
    // The check that does not depend on the key being right. A verdict is a statement ABOUT a workspace, and
    // attaching it to another one is not a lost result — it is a fabricated one.
    expect(
      () =>
        mergeVerifierPass(RESULT, {
          planDigest: "sha256:plan",
          workspaceDigest: "sha256:some-other-tree",
          scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        } as never),
      "a verdict was merged onto evidence it was never about",
    ).toThrow(/different workspace/i);
  });

  it("MERGES when the two halves are about the same tree", () => {
    // The control: refusing a mismatch must not cost the merge it exists to protect.
    const merged = mergeVerifierPass(RESULT, {
      planDigest: "sha256:plan",
      workspaceDigest: contentDigest(RESULT.snapshot),
      scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
    } as never);
    expect(merged.verifier).toBeDefined();
    expect(merged.scores?.some((sc) => sc.metric === "tests_pass")).toBe(true);
  });

  it("does not fail the case when staging fails — it costs the RECOVERY, not the run", async () => {
    // Best-effort by contract. Refusing a case that ran because an artifact store hiccuped would trade a real
    // result for a store's bad minute; the honest consequence of an absent stage is what the recovery already
    // does with a verdict it cannot attribute.
    const result = await withVerifierPass(JOB(), {
      dispatch: async () => RESULT,
      dispatchVerifier: async (): Promise<VerifierInvocation> =>
        ({
          planDigest: "sha256:plan",
          workspaceDigest: contentDigest(RESULT.snapshot),
          scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        }) as unknown as VerifierInvocation,
      agentHalves: {
        put: async () => {
          throw new Error("artifact store unavailable");
        },
        get: async () => undefined,
      },
    });
    expect(
      result.scores?.some((s) => s.metric === "tests_pass"),
      "a store hiccup cost the case its verdict",
    ).toBe(true);
  });

  it("still runs the two halves when the deployment stages nothing at all", async () => {
    // No artifact store is the single-process and pre-existing case: the pass behaves exactly as before.
    const result = await withVerifierPass(JOB(), {
      dispatch: async () => RESULT,
      dispatchVerifier: async (): Promise<VerifierInvocation> =>
        ({
          planDigest: "sha256:plan",
          workspaceDigest: contentDigest(RESULT.snapshot),
          scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        }) as unknown as VerifierInvocation,
    });
    expect(result.verifier, "the verifier receipt did not reach the result").toBeDefined();
  });
});
