import type { VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { mergeVerifierPass } from "./agent-half.js";
import { verifierOperation } from "./verifier-operation.js";

// ── A SUB-STEP'S TERMINAL IS NOT THE CANONICAL TERMINAL (arch-review 64 P1-high) ─────────────────────
//
// `committed` means "this attempt's result is the case's answer". `verifierOperation` stamped it the moment
// its container returned scores — and at that moment three later steps can still withhold the adoption: the
// merge can refuse the verdict as being about a different workspace, the deferred collection can fail, a
// speculative sibling can win the receipt.
//
// The correction for the first of those was written — flip the row to `superseded` — and it could never run,
// for TWO independent reasons:
//
//   1. `committed` is terminal and every store is first-terminal-wins, so `committed → superseded` is refused
//      by construction. A compensation the state machine forbids is not a compensation.
//   2. `VerifierAwareDispatcher`'s constructor was `(inner, dispatchVerifier, agentHalves)` — there was no
//      parameter to pass a ledger through — so `deps.attempts` was `undefined` in every production dispatch.
//
// And its counterexample was green over both, because its double was `transition: async () => true`: an
// assertion that we had ASKED. That is the always-succeeds-double law, broken in the wave that wrote it, which
// is why `pnpm guarded-doubles` now enforces it and why this file uses the real in-memory store and reads the
// ROW back.
//
// Seen RED before `verdict_produced`, observed:
//   a verdict nobody has adopted is recorded as the case's answer: expected 'committed' to be 'verdict_produced'
//   a refused verdict is left claiming it contributed: expected 'committed' to be 'superseded'

const JOB: VerifierJob = {
  runId: "evd-run-r1",
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "" },
  plan: { digest: "sha256:plan", graders: [] },
  timeoutSec: 60,
} as unknown as VerifierJob;

const VERDICT = (workspaceDigest: string): VerifierInvocation =>
  ({
    planDigest: "sha256:plan",
    workspaceDigest,
    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
  }) as unknown as VerifierInvocation;

// The lane, driven through `verifierOperation` exactly as both managed backends drive it: reserve through the
// authority, activate, answer an invocation.
const runLane = async (attempts: InMemoryExecutionAttemptStore, invocation: VerifierInvocation) =>
  await verifierOperation({ attempts }, JOB, async (job, hooks) => {
    const work = { tenant: job.tenant, runId: job.runId, externalJobId: "everdict-verify-c1" };
    await hooks.authority.reserve(work);
    await hooks.authority.activate(work);
    return invocation;
  });

const stateOf = async (attempts: InMemoryExecutionAttemptStore) =>
  (await attempts.list(storedExecutionId("evd-run-r1")))[0]?.state;

describe("[R64 COUNTEREXAMPLE] a produced verdict is not an adopted one", () => {
  it("stops at `verdict_produced` — the bytes exist, nobody has decided", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const invocation = await runLane(attempts, VERDICT("sha256:tree"));

    expect(invocation.scores, "the lane produced no verdict, so this file measured nothing").toHaveLength(1);
    expect(await stateOf(attempts), "a verdict nobody has adopted is recorded as the case's answer").toBe(
      "verdict_produced",
    );
  });

  it("REFUSES to create more work from there", async () => {
    // The reason the phase is non-terminal AND guarded: its container is gone and its bytes are staged, so it
    // is waiting — but an attempt that has already answered may not place a second object. Before this, the
    // birth guard hand-listed the terminal three and a `verdict_produced` row fell through every arm.
    const attempts = new InMemoryExecutionAttemptStore();
    await runLane(attempts, VERDICT("sha256:tree"));
    const [row] = await attempts.list(storedExecutionId("evd-run-r1"));
    const attemptId = row?.attemptId;
    if (attemptId === undefined) throw new Error("the lane opened a row, so it has an id");

    const decision = await attempts.activateWork(attemptId, {
      tenant: "acme",
      runId: "evd-run-r1",
      externalJobId: "everdict-verify-c1",
    });
    expect(decision.kind, "an attempt that already answered was authorized to create more work").toBe("refuse");
  });

  it("can still be SUPERSEDED when the merge refuses its verdict", async () => {
    // The correction that was written twice and never once performed. From `verdict_produced` it is an
    // ordinary write; from `committed` every real store refused it.
    const attempts = new InMemoryExecutionAttemptStore();
    // A verdict about a DIFFERENT tree than the half it would join — the check `mergeVerifierPass` makes.
    const invocation = await runLane(attempts, VERDICT("sha256:some-other-tree"));
    const [row] = await attempts.list(storedExecutionId("evd-run-r1"));
    const attemptId = row?.attemptId;
    if (attemptId === undefined) throw new Error("the lane opened a row, so it has an id");

    expect(() =>
      mergeVerifierPass(
        { caseId: "c1", harness: "h@1", trace: [], snapshot: { kind: "repo", diff: "" } } as never,
        invocation,
      ),
    ).toThrow();

    expect(
      await attempts.transition(attemptId, "superseded"),
      "the correction for a refused verdict was refused by the state machine",
    ).toBe(true);
    expect(await stateOf(attempts)).toBe("superseded");
  });

  it("becomes `committed` when a settlement adopts it", async () => {
    // The other half of the phase, and the one that keeps it from being a leak: something has to end it. The
    // canonical settlement writes this — see the run and batch commit paths — and it must be reachable.
    const attempts = new InMemoryExecutionAttemptStore();
    await runLane(attempts, VERDICT("sha256:tree"));
    const [row] = await attempts.list(storedExecutionId("evd-run-r1"));
    const attemptId = row?.attemptId;
    if (attemptId === undefined) throw new Error("the lane opened a row, so it has an id");

    expect(await attempts.transition(attemptId, "committed")).toBe(true);
    expect(await stateOf(attempts)).toBe("committed");
  });

  it("a verdict may NOT be reported from a row that reserved nothing", async () => {
    // The control on the new predecessor list: `verdict_produced` is a statement that a container ran, so a
    // `created` row reaching it would be a verdict from an attempt that placed nothing.
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: storedExecutionId("evd-run-r2"), tenant: "acme" });
    expect(await attempts.transition(attemptId, "verdict_produced")).toBe(false);
  });
});
