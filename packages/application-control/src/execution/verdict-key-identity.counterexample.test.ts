import type { CaseResult, RuntimeWorkRef, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { CaseResultSchema, VerifierInvocationSchema, isMeasured, storedExecutionId } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { type AgentHalfStore, agentHalfDigest, recoverStagedVerdict, stageAgentHalf } from "./agent-half.js";
import { type VerifierDispatchHooks, verifierOperation } from "./verifier-operation.js";

// ── ONE KEY FOR TWO EXECUTIONS IS A KEY THAT NAMES NEITHER (arch-review 65 P1) ──────────────────────
//
// `verifierVerdictKey` was `(tenant, runId, agentResultDigest)`. All three are properties of the AGENT's half,
// so every verifier attempt judging that half addressed the same object — and `put` is not a conditional
// create. A deterministic re-drive, a re-lease after a lost heartbeat, a speculative duplicate: whichever
// verifier finished last silently destroyed the other's verdict, and a recovery holding the loser's handle
// read the winner's bytes.
//
// That is the hazard `agentHalfKey`'s own history is a record of, one document over. Its comment says it in
// as many words — a key built from what two attempts SHARE is a key at which the later write wins.
//
// The verifier attempt is the discriminator, and every recovery already holds it: it is the `attemptId` on the
// handle the ledger stored, which is the same handle the recovery is recovering from.
//
// Seen RED with the attempt segment removed from the key, observed:
//   verifier A's recovery read whichever verdict was written last: expected 'unknown' to be 'merged'
//
// `unknown` rather than a wrong merge only because the handle check landed in the same wave — the two
// protocols compose, and each is worth having alone. Without the key, every second verdict is destroyed and
// the case re-runs; without the check, the surviving one is merged as if it belonged.

const RUN = "evd-run-r1";
const EXECUTION = storedExecutionId(RUN);

const AGENT_HALF: CaseResult = CaseResultSchema.parse({
  caseId: "c1",
  harness: "cc@1.0.0",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "the agent ran" }],
  scores: [{ graderId: "steps", metric: "steps", value: 7 }],
  snapshot: { kind: "repo", diff: "diff --git a/x b/x", changedFiles: [], base: "base-sha", headSha: "head-sha" },
});

const DIGEST = agentHalfDigest(AGENT_HALF);

// The judging job, twice over: the same agent half, the same plan, the same workspace. Everything the old key
// was built from is identical between the two attempts, which is the whole point — they differ only in WHICH
// container ran, and that is precisely what the key did not record.
const JOB: VerifierJob = {
  runId: RUN,
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: AGENT_HALF.snapshot,
  plan: { digest: "sha256:plan", graders: [] },
  timeoutSec: 60,
  agentResultDigest: DIGEST,
  // The AGENT's physical execution — a different row from either verifier's, which is why the fixture opens
  // it below rather than letting the two ids collide (rule `testing`: a fixture whose ids all match is not
  // the production shape, and a check comparing two of them cannot fail).
  agentAttemptId: `${EXECUTION}#g1`,
} as unknown as VerifierJob;

function verdict(value: number): VerifierInvocation {
  return VerifierInvocationSchema.parse({
    planDigest: "sha256:plan",
    workspaceDigest: contentDigest(AGENT_HALF.snapshot),
    scores: [{ graderId: "reward-file", metric: "tests_pass", value, pass: value === 1 }],
    imageProvenance: { kind: "resolved", images: [{ ref: "verifier:1", digest: "sha256:img" }], by: "orchestrator" },
  });
}

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

// Two verifier containers over one staged half, run through the REAL operation so the attempt rows, the
// reservations and the staged documents are the ones production writes.
const twoVerifiers = async () => {
  const artifacts = store();
  const attempts = new InMemoryExecutionAttemptStore();
  await stageAgentHalf(artifacts, "acme", RUN, AGENT_HALF);
  // The agent's own row, opened first exactly as the lane opens it — so the verifiers are `#g2` and `#g3` and
  // no two ids in this file are accidentally equal.
  await attempts.open({ executionId: EXECUTION, tenant: "acme", caseId: "c1" });

  const lane =
    (externalJobId: string, invocation: VerifierInvocation) =>
    async (job: VerifierJob, hooks: VerifierDispatchHooks): Promise<VerifierInvocation> => {
      const work = { tenant: job.tenant, runId: job.runId, externalJobId };
      await hooks.authority.reserve(work);
      await hooks.authority.activate(work);
      return invocation;
    };

  const a = await verifierOperation({ attempts, verdicts: artifacts }, JOB, lane("everdict-verify-c1-a", verdict(1)));
  const b = await verifierOperation({ attempts, verdicts: artifacts }, JOB, lane("everdict-verify-c1-b", verdict(0)));
  return { artifacts, attempts, a, b };
};

// The handle a recovery finds on the ledger — read from the ROW, not hand-built, because the row is where a
// restarted control plane gets it and `reserveWork` is what put the verifier coordinate on it.
async function handleFor(attempts: InMemoryExecutionAttemptStore, attemptId: string): Promise<RuntimeWorkRef> {
  const rows = await attempts.list(EXECUTION);
  const work = rows.find((r) => r.attemptId === attemptId)?.runtimeWork;
  if (!work) throw new Error(`the ledger holds no handle for ${attemptId}, so this fixture measures nothing`);
  return work;
}

describe("[R65 COUNTEREXAMPLE] a staged verdict is addressed by the verifier that produced it", () => {
  it("keeps both verdicts, under one key each", async () => {
    const { artifacts, a, b } = await twoVerifiers();
    expect(a.work?.attemptId, "the two verifiers shared an attempt row, so this file measures nothing").not.toBe(
      b.work?.attemptId,
    );

    const verdictKeys = artifacts.keys().filter((k) => k.startsWith("verifier-verdict/"));
    expect(verdictKeys, "the second verdict overwrote the first at a key they shared").toHaveLength(2);
  });

  it("recovers the verdict belonging to the handle it is recovering from", async () => {
    const { artifacts, attempts, a, b } = await twoVerifiers();

    // The crash. Both containers are gone; the ledger and the object store are all that survive.
    for (const [invocation, expected] of [
      [a, 1],
      [b, 0],
    ] as const) {
      const attemptId = invocation.work?.attemptId;
      expect(attemptId, "the operation returned no canonical handle").toBeDefined();
      if (attemptId === undefined) return;

      const recovered = await recoverStagedVerdict(
        artifacts,
        artifacts,
        "acme",
        RUN,
        await handleFor(attempts, attemptId),
      );
      expect(recovered.kind, "verifier A's recovery read whichever verdict was written last").toBe("merged");
      if (recovered.kind !== "merged") return;

      // Narrowed rather than reached into: a `Score` is a union and the unmeasured arm has no `value`, so a
      // case that came back unjudged would otherwise compare `undefined` against `undefined` and pass.
      const testsPass = recovered.result.scores?.find((s) => s.metric === "tests_pass");
      expect(testsPass !== undefined && isMeasured(testsPass), "the recovered case was not judged at all").toBe(true);
      if (testsPass === undefined || !isMeasured(testsPass)) return;
      expect(testsPass.value, "the recovered case carries the OTHER attempt's verdict").toBe(expected);
      // …and it is attributed to the attempt that actually produced it, not to whichever wrote last.
      expect(recovered.result.verifier?.work?.attemptId).toBe(attemptId);
      expect(recovered.attempts.verifier).toBe(attemptId);
      // The agent's execution is the case's, and it is the SAME one for both verdicts — two judgments of one
      // half, which is what makes the shared key so easy to write and so wrong.
      expect(recovered.attempts.agent).toBe(`${EXECUTION}#g1`);
    }
  });

  it("REFUSES a verdict whose bytes describe another execution, rather than merging it", async () => {
    // The control for the other half of the pair. Hand a recovery verifier A's handle and B's key by pointing
    // the read at B's object: the bytes parse, the workspace matches, the plan matches — everything the merge
    // itself checks is satisfied — and the attempt and container are somebody else's.
    const { artifacts, attempts, a, b } = await twoVerifiers();
    const attemptA = a.work?.attemptId;
    const attemptB = b.work?.attemptId;
    if (attemptA === undefined || attemptB === undefined) throw new Error("no canonical handles");

    const bBytes = await artifacts.get(
      artifacts.keys().filter((k) => k.startsWith("verifier-verdict/") && k.endsWith(`/${attemptB}.json`))[0] ?? "",
    );
    expect(bBytes, "verifier B staged nothing, so the swap below measures nothing").toBeDefined();
    const swapped: AgentHalfStore = {
      put: artifacts.put.bind(artifacts),
      remove: artifacts.remove.bind(artifacts),
      // Exactly what a shared key WAS: A's coordinate, B's bytes.
      async get() {
        return bBytes;
      },
    };

    const recovered = await recoverStagedVerdict(artifacts, swapped, "acme", RUN, await handleFor(attempts, attemptA));
    expect(recovered.kind, "another execution's verdict was merged as this handle's own").toBe("unknown");
  });
});
