import { storedExecutionId } from "@everdict/contracts";
import type { CaseJob, CaseResult, VerifierInvocation } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { agentHalfDigest, agentHalfKey, mergeVerifierPass, readAgentHalf } from "./agent-half.js";
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
    const staged: string[] = [];
    const written = new Map<string, Uint8Array>();
    const halves = {
      put: async (key: string, data: Uint8Array) => {
        order.push("stage");
        staged.push(key);
        written.set(key, data);
        return "ref";
      },
      get: async (key: string) => written.get(key),
      remove: async (key: string) => {
        written.delete(key);
      },
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
    // …under the key the RECOVERY addresses, which the verifier's handle carries. Keyed by the RESULT, not
    // the workspace: two attempts of one case can leave byte-identical trees and differ in everything else,
    // and the tree's key is one object (arch-review 61 P1-high, narrowed by 62 P1).
    //
    // Asserted from what was WRITTEN rather than what is still there: the pass discards its half once the
    // verdict is merged (see the retention describe below), so the store is empty by now and that is correct.
    const digest = agentHalfDigest(RESULT);
    expect(staged).toEqual([agentHalfKey("acme", "evd-run-r1", digest)]);

    // …and it reads back as the agent's own result, through the contract rather than a cast. Written back in
    // for this read, because the pass has already discarded it — the bytes are what is under test here, not
    // the retention.
    written.set(agentHalfKey("acme", "evd-run-r1", digest), new TextEncoder().encode(JSON.stringify(RESULT)));
    const half = await readAgentHalf(halves, "acme", "evd-run-r1", digest);
    expect(half.kind).toBe("read");
    expect(half.kind === "read" && half.result.harness).toBe("agent@1");
  });

  it("cannot be OVERWRITTEN by another attempt of the same execution", () => {
    // `runId` is the LOGICAL execution — the same across a retry, a speculative second attempt and a
    // re-lease — and an object store's write replaces what is at a key. Two attempts staging to one object
    // meant a recovery could merge attempt A's VERDICT onto attempt B's EVIDENCE: a case that never happened,
    // assembled from two that did, with no seam a downstream reader can see (arch-review 61 P1-high).
    // …AND BY ANOTHER ATTEMPT THAT LEFT THE SAME TREE (arch-review 62 P1). Keying on the workspace closed
    // the wrong-tree merge and left this one open: a deterministic task re-run, a re-lease or a speculative
    // duplicate produces byte-identical files and a completely different execution — different trace,
    // observation scores, runtime and image provenance, timings. Same key, so the later write replaced the
    // earlier, and a verdict from the first attempt merged onto the second attempt's evidence with the
    // workspace check passing because the trees really were the same.
    const sameTree: CaseResult["snapshot"] = { kind: "repo", diff: "A", changedFiles: ["a"], headSha: "sha-a" };
    const attemptA = agentHalfDigest({ ...RESULT, snapshot: sameTree, trace: [{ t: 1 } as never] });
    const attemptB = agentHalfDigest({ ...RESULT, snapshot: sameTree, trace: [{ t: 2 } as never] });
    expect(contentDigest(sameTree), "the two attempts did not share a tree, so this proves nothing").toBe(
      contentDigest(sameTree),
    );
    expect(
      agentHalfKey("acme", "evd-run-r1", attemptA),
      "two executions leaving the same tree stage to the same object",
    ).not.toBe(agentHalfKey("acme", "evd-run-r1", attemptB));

    const a = agentHalfDigest({ ...RESULT, snapshot: { kind: "repo", diff: "A", changedFiles: ["a"], headSha: "a" } });
    const b = agentHalfDigest({ ...RESULT, snapshot: { kind: "repo", diff: "B", changedFiles: ["b"], headSha: "b" } });
    expect(a, "two different halves digested the same, so this test proves nothing").not.toBe(b);
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
        remove: async () => undefined,
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

// ── …AND THE WINDOW ENDS AT THE SETTLEMENT, NOT AT THE MERGE (arch-review 63 P0) ────────────────────
//
// The first version of this file put the retention owner at the MERGE — the step that consumes the half —
// and asserted the deletion there. That is one step too early, and the assertion was pinning the defect.
//
// After the merge a case still runs its deferred trace collection, its observation graders and its evidence
// assembly, and only then settles. A crash anywhere in there found the agent's container gone, the
// verifier's container gone AND the staged half deleted, so the case re-ran from nothing — which is exactly
// what the half was staged to prevent.
//
// An artifact that exists so a crash can be recovered from is owed until the thing it would recover is
// DURABLE, not until its value has been read: a value in memory is precisely what it was staged to survive.
// So the merge keeps it, and the settlement discards it (see `discardAgentHalf`'s caller in the recovery
// lane, and rule `protocol`).
//
// Seen RED before the invariant was corrected, observed:
//   the merge deleted a half the settlement still needed: expected 1 to be +0
describe("[R63 COUNTEREXAMPLE] the merge does not discard the half the settlement still needs", () => {
  const halvesRecording = (written: Map<string, Uint8Array>) => ({
    put: async (key: string, data: Uint8Array) => {
      written.set(key, data);
      return "ref";
    },
    get: async (key: string) => written.get(key),
    remove: async (key: string) => {
      written.delete(key);
    },
  });

  it("KEEPS the half after a successful merge — the case is not settled yet", async () => {
    const written = new Map<string, Uint8Array>();
    const merged = await withVerifierPass(JOB(), {
      dispatch: async () => RESULT,
      dispatchVerifier: async (): Promise<VerifierInvocation> =>
        ({
          planDigest: "sha256:plan",
          workspaceDigest: contentDigest(RESULT.snapshot),
          scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        }) as unknown as VerifierInvocation,
      agentHalves: halvesRecording(written),
    } as never);

    // The control first: a pass that never merged would keep the half for the wrong reason.
    expect(merged.verifier, "the verdict never reached the result, so the retention claim is vacuous").toBeDefined();
    expect(written.size, "the merge deleted a half the settlement still needed").toBe(1);
  });

  it("KEEPS it when the verifier FAILED too", async () => {
    // The case still has to be completed and settled; a crash before that is the window the half covers.
    const written = new Map<string, Uint8Array>();
    await withVerifierPass(JOB(), {
      dispatch: async () => RESULT,
      dispatchVerifier: async () => {
        throw new Error("the lane refused");
      },
      agentHalves: halvesRecording(written),
    } as never);

    expect(written.size, "a failed verifier deleted the half its case still needs").toBe(1);
  });

  it("stages NOTHING for a case whose verifier can never be dispatched", async () => {
    // Unchanged and still true: a prompt snapshot has no workspace to judge, so this case is refused before
    // any second container — there is no window, and a half written for it would be garbage from birth.
    const written = new Map<string, Uint8Array>();
    await withVerifierPass(JOB(), {
      dispatch: async () => ({ ...RESULT, snapshot: { kind: "prompt", output: "x" } }) as CaseResult,
      dispatchVerifier: async (): Promise<VerifierInvocation> => {
        throw new Error("must not be reached");
      },
      agentHalves: halvesRecording(written),
    } as never);

    expect(written.size, "a half was staged for a case that never opened a window").toBe(0);
  });
});

// ── A VERDICT THAT WAS NOT USED DOES NOT CLAIM IT WAS (arch-review 63 P1-high) ───────────────────────
//
// `verifierOperation` stamps the verifier's attempt `committed` the moment the verdict exists, and the merge
// that decides whether the verdict is USED runs afterwards. When that merge is refused — the verdict was
// produced against a different workspace than the half it would join — the ledger was left saying an attempt
// contributed to a case that did not take it.
//
// The deeper repair is a pre-terminal state (`verdict_produced`) so `committed` is only ever written by the
// settlement, and that is a vocabulary change every guard has to be re-walked for. Not attempted here, and
// said so rather than implied: this closes the one case where the record is demonstrably FALSE, using the
// state that already means "another attempt's work replaced this one's".
//
// Seen RED before the correction, observed:
//   a refused verdict was left claiming it contributed: expected 'committed' to be 'superseded'
describe("[R63 COUNTEREXAMPLE] a refused merge corrects the attempt that produced the verdict", () => {
  const REFUSED: VerifierInvocation = {
    planDigest: "sha256:plan",
    // A verdict about a DIFFERENT tree than the half it would merge into — the check `mergeVerifierPass`
    // makes, and the reason this verdict cannot be used.
    workspaceDigest: "sha256:some-other-tree",
    work: { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-verify-c1", attemptId: "a-verify" },
    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
  } as unknown as VerifierInvocation;

  // ── AGAINST THE REAL LEDGER, AND READING THE ROW (arch-review 64) ────────────────────────────────
  //
  // These two used to hand `withVerifierPass` a double whose `transition` returned `true` unconditionally, so
  // the assertion recorded that we had ASKED. It hid TWO things at once: the real store refuses
  // `committed → superseded` outright (first-terminal-wins), and production had no constructor parameter to
  // pass a ledger through at all. The correction was inert twice over and this file was green.
  //
  // Now the lane stops at `verdict_produced`, from which `superseded` is an ordinary write, and the row is
  // read back rather than a call log. `pnpm guarded-doubles` is what keeps the old shape from coming back.
  const ledgerHoldingVerdict = async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: storedExecutionId("evd-run-r1"), tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "v" });
    await attempts.transition(attemptId, "verdict_produced");
    return { attempts, attemptId };
  };

  it("SUPERSEDES the verifier attempt when its verdict is refused", async () => {
    const { attempts, attemptId } = await ledgerHoldingVerdict();
    const out = await withVerifierPass(JOB(), {
      dispatch: async () => RESULT,
      dispatchVerifier: async () => ({ ...REFUSED, work: { ...REFUSED.work, attemptId } }),
      attempts,
    } as never);

    // The control first: the merge really was refused, or there is nothing to correct.
    expect(out.verifier, "the merge was not refused, so this test measured nothing").toBeUndefined();
    const [row] = await attempts.list(storedExecutionId("evd-run-r1"));
    expect(row?.state, "a refused verdict was left claiming it contributed").toBe("superseded");
  });

  it("leaves the attempt alone when the verdict IS used", async () => {
    // The control. Correcting an attempt whose verdict landed would be a worse record than the one this
    // fixes, and the assertion above would still pass. The row stays at `verdict_produced` — waiting for the
    // SETTLEMENT to adopt it, which is the whole point of the phase.
    const { attempts, attemptId } = await ledgerHoldingVerdict();
    const out = await withVerifierPass(JOB(), {
      dispatch: async () => RESULT,
      dispatchVerifier: async (): Promise<VerifierInvocation> =>
        ({
          planDigest: "sha256:plan",
          workspaceDigest: contentDigest(RESULT.snapshot),
          work: { tenant: "acme", runId: "evd-run-r1", externalJobId: "v", attemptId },
          scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
        }) as unknown as VerifierInvocation,
      attempts,
    } as never);

    expect(out.verifier, "the verdict never reached the result, so the assertion below is vacuous").toBeDefined();
    const [row] = await attempts.list(storedExecutionId("evd-run-r1"));
    expect(row?.state, "an attempt whose verdict was used was corrected anyway").toBe("verdict_produced");
  });
});
