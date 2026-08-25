import {
  InMemoryExecutionAttemptStore,
  InMemoryIntermediateCleanupStore,
  IntermediateCleanupReconciler,
  agentHalfDigest,
  agentHalfKey,
  cleanupRemover,
  readAgentHalf,
  recoverStagedVerdict,
  stageAgentHalf,
  verifierOperation,
} from "@everdict/application-control";
import type { CaseResult, RuntimeWorkRef, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { S3ArtifactStore } from "@everdict/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-181.
//
// THE TWO-PHASE CASE'S INTERMEDIATES, AGAINST A STORE THAT CAN DISAGREE (arch-review 68).
//
// Four consecutive reviews have centred on these artifacts — where the agent half is keyed (61, 62), whether
// the address authenticates the bytes (66), whether a taken key is the same bytes (67), and who owes their
// deletion (66, 67). Every repair was verified against a `vi.spyOn(S3Client.prototype, "send")` that throws a
// SYNTHETIC 412, or against a `Map` standing in for an object store. Both prove the branch. Neither can prove
// the premise, and the premise is a sentence about somebody else's software:
//
//     `IfNoneMatch: "*"` is the S3 conditional create (and MinIO implements it)   — s3.ts
//
// If that header were dropped by the SDK, unsupported by the endpoint, or answered with anything but 412, the
// mocked counterexample stays green and production silently overwrites — which is the exact failure the
// conditional create was added to stop. A comment promising another component's behaviour is a claim, and the
// claim needs the test (rule `protocol`).
//
// So this drives the PRODUCTION composition — `stageAgentHalf`, `verifierOperation`, `recoverStagedVerdict`,
// `IntermediateCleanupReconciler` — against a real S3 endpoint, and asserts what is in the store afterwards
// rather than what was called.
//
// Seen RED against a real MinIO with the conditional create removed from `put`, observed:
//   a second attempt's bytes replaced an immutable object: expected 'the first attempt ran' to be 'the second attempt ran'
const ENDPOINT = process.env.EVERDICT_TRUST_S3_ENDPOINT;
const ACCESS_KEY = process.env.EVERDICT_TRUST_S3_ACCESS_KEY;
const SECRET_KEY = process.env.EVERDICT_TRUST_S3_SECRET_KEY;
const ENABLED = process.env.EVERDICT_TRUST_SUITE === "1" && Boolean(ENDPOINT && ACCESS_KEY && SECRET_KEY);

const TENANT = "acme";

// Per-run identity, for the reason `trustId` exists in the api suite: these scenarios write into a bucket
// that keeps its objects, and an immutable key is by construction one a rerun cannot rewrite.
const runId = (): string => `evd-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ONE snapshot value, shared by the half and by the job the verifier is handed. `withVerifierPass` sets
// `workspace: result.snapshot`, so in production these are the same object; a fixture that spells them twice
// could drift and the merge's tree check would then be measuring the fixture.
const SNAPSHOT = { kind: "repo", diff: "", changedFiles: [], headSha: "h" } as const;

const result = (text: string): CaseResult =>
  ({
    caseId: "c1",
    harness: "h@1",
    trace: [{ t: 0, kind: "log", stream: "stdout", text }],
    scores: [],
    snapshot: SNAPSHOT,
  }) as unknown as CaseResult;

const textOf = (r: CaseResult): string => {
  const first = r.trace[0];
  return first !== undefined && "text" in first && typeof first.text === "string" ? first.text : "";
};

const verifierJob = (over: Partial<VerifierJob>): VerifierJob =>
  ({
    runId: "r1",
    tenant: TENANT,
    caseId: "c1",
    workdir: "/app",
    workspace: SNAPSHOT,
    plan: { digest: "sha256:plan", graders: [{ id: "reward-file", config: {} }] },
    timeoutSec: 600,
    ...over,
  }) as VerifierJob;

// A verdict reports the digest of the tree it was HANDED — which is what a real verifier does, and what
// `mergeVerifierPass` compares against the half it would attach to. A fixture that names a constant instead
// is a fixture whose merge could never be refused for the reason production refuses it.
const verdictOf = (job: VerifierJob, value: number): VerifierInvocation => ({
  planDigest: "sha256:plan",
  workspaceDigest: contentDigest(job.workspace),
  scores: [{ graderId: "reward-file", metric: "tests_pass", value, pass: value === 1 }],
});

describe.skipIf(!ENABLED)("TRUST-181 — the staged intermediates against a real object store", () => {
  if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY) return; // narrowing, separate from skipIf

  const store = new S3ArtifactStore({
    endpoint: ENDPOINT,
    bucket: "everdict-trust-intermediates",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });

  beforeAll(async () => {
    await store.ensureBucket();
  });

  // Every scenario stages, so every scenario owes. Draining here keeps a rerun from accumulating objects in a
  // bucket whose keys are immutable by design.
  const owed = new InMemoryIntermediateCleanupStore();
  afterAll(async () => {
    for (const debt of owed.snapshot()) await owed.releaseForGc(debt.tenant, debt.executionId);
    await new IntermediateCleanupReconciler({
      cleanup: owed,
      remove: cleanupRemover({ agentHalves: store, verdicts: store }),
      batch: 500,
    }).tick();
  });

  it("REFUSES a second attempt's bytes at an immutable key — the conditional create reaches the endpoint", async () => {
    // The premise, stated as an experiment rather than as a comment. Two attempts staging under ONE key: the
    // key is normally the result digest, so this drives the collision directly through the adapter the lane
    // spends, with the immutability the lane declares.
    const key = `agent-half/${TENANT}/${runId()}/sha256:shared.json`;
    const first = new TextEncoder().encode(JSON.stringify({ attempt: "the first attempt ran" }));
    const second = new TextEncoder().encode(JSON.stringify({ attempt: "the second attempt ran" }));

    await store.put(key, first, "application/json", { immutable: true, digest: "sha256:shared" });
    await expect(
      store.put(key, second, "application/json", { immutable: true, digest: "sha256:shared" }),
      "a second attempt's bytes replaced an immutable object",
    ).rejects.toThrow(/already holds different bytes/);

    const back = await store.get(key);
    expect(back, "the object could not be read back at all").toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(back ?? new Uint8Array())).attempt).toBe("the first attempt ran");
  });

  it("CONVERGES on a rewrite of the same bytes — a retry must not fail a case that already staged", async () => {
    // The other side of the same branch, and the reason the adapter reads a verified 412 as success rather
    // than refusing every occupied key: staging is at-least-once, and an idempotent re-put is the normal way
    // a retried dispatch arrives.
    const key = `agent-half/${TENANT}/${runId()}/sha256:same.json`;
    const bytes = new TextEncoder().encode(JSON.stringify({ attempt: "one" }));

    await store.put(key, bytes, "application/json", { immutable: true, digest: "sha256:same" });
    await expect(
      store.put(key, bytes, "application/json", { immutable: true, digest: "sha256:same" }),
      "a convergent rewrite was refused, so an ordinary retry fails a case that already staged",
    ).resolves.toBeTypeOf("string");
  });

  it("gives two interleaved attempts of ONE execution their own halves, and reads each back by digest", async () => {
    // The interleaving the key's whole history is about (arch-review 61 → 62), against a store where "the
    // later write wins" is a real property rather than a Map's. Both attempts stage under the same execution;
    // each recovery must reach the half its own verdict is about.
    const run = runId();
    const a = result("attempt A evidence");
    const b = result("attempt B evidence");

    await stageAgentHalf(store, TENANT, run, a, owed);
    await stageAgentHalf(store, TENANT, run, b, owed);

    const readA = await readAgentHalf(store, TENANT, run, agentHalfDigest(a));
    const readB = await readAgentHalf(store, TENANT, run, agentHalfDigest(b));

    expect(readA.kind, "attempt A's half was not readable after B staged").toBe("read");
    expect(readB.kind).toBe("read");
    expect(readA.kind === "read" ? textOf(readA.result) : "").toBe("attempt A evidence");
    expect(readB.kind === "read" ? textOf(readB.result) : "").toBe("attempt B evidence");
  });

  it("answers UNKNOWN when the bytes at a half's address are not the ones its digest names", async () => {
    // The conditional create is OPT-IN, so anything writing without the flag — run media, an older writer, a
    // repair script — can still land at this address. The read's own digest check is the defence that does
    // not depend on the writer having asked for one, and this drives it against real bytes rather than a Map
    // seeded by hand (arch-review 66 P1-provenance).
    const run = runId();
    const staged = result("the half that was staged");
    await stageAgentHalf(store, TENANT, run, staged, owed);

    const digest = agentHalfDigest(staged);
    // A plain, non-immutable put: schema-valid, different execution, same address.
    const impostor = new TextEncoder().encode(JSON.stringify(result("a document that was never this half")));
    await store.put(agentHalfKey(TENANT, run, digest), impostor, "application/json");

    const read = await readAgentHalf(store, TENANT, run, digest);
    expect(read.kind, "a document the address does not name was merged as the staged half").toBe("unknown");
    expect(read.kind === "unknown" ? read.reason : "").toContain("hash to");
  });

  it("answers ABSENT — not unknown — for a half that was never staged", async () => {
    // The distinction a recovery's re-drive decision rests on, and it is the ADAPTER's to make: MinIO answers
    // `NoSuchKey`, and `isNotFound` has to recognise the real error rather than the shape a fake produces. If
    // this read answered `unknown`, no recovery could ever conclude "nothing was staged" and every un-staged
    // case would be retried forever instead of re-driven once.
    const read = await readAgentHalf(store, TENANT, runId(), "sha256:nothing-was-ever-written-here");
    expect(read.kind, "a never-staged half read as a store that would not answer").toBe("absent");
  });

  it("recovers a two-phase case from bytes only — verdict, half, and the handle they must agree with", async () => {
    // The whole lane, end to end, through the production entry points: the pass stages the agent's half, the
    // verifier operation stages its verdict, and a recovery that holds nothing but the handle reassembles the
    // case from the object store.
    const run = runId();
    const half = result("the agent's half, recovered from bytes");
    await stageAgentHalf(store, TENANT, run, half, owed);

    const agentResultDigest = agentHalfDigest(half);
    // The tree the verifier is handed is the half's own snapshot — `withVerifierPass` sets
    // `workspace: result.snapshot`, and the merge compares the verdict's digest against exactly that.
    const judgedTree = contentDigest(SNAPSHOT);
    const attempts = new InMemoryExecutionAttemptStore();
    const externalJobId = `everdict-verify-${run}`;

    const invocation = await verifierOperation(
      { attempts, verdicts: store, cleanup: owed, durability: "required" },
      verifierJob({ runId: run, agentResultDigest }),
      async (_job, hooks) => {
        await hooks.authority.reserve({ tenant: TENANT, runId: run, externalJobId });
        return verdictOf(_job, 1);
      },
    );

    // The handle a restart would hold: the verifier's work ref, carrying which half it judged.
    const handle: RuntimeWorkRef = {
      tenant: TENANT,
      runId: run,
      externalJobId,
      ...(invocation.work?.attemptId !== undefined ? { attemptId: invocation.work.attemptId } : {}),
      verifier: { planDigest: "sha256:plan", workspaceDigest: judgedTree, caseId: "c1", agentResultDigest },
    };

    const recovered = await recoverStagedVerdict(store, store, TENANT, run, handle);
    expect(recovered.kind, "the case could not be reassembled from durable bytes alone").toBe("merged");
    if (recovered.kind !== "merged") return;
    expect(textOf(recovered.result), "the recovery merged a verdict onto somebody else's evidence").toBe(
      "the agent's half, recovered from bytes",
    );
    expect(recovered.result.scores.some((s) => s.metric === "tests_pass")).toBe(true);
  });

  it("REFUSES to recover from a handle the staged verdict does not name", async () => {
    // Staged bytes are ADDRESSED, not authenticated (arch-review 65). A recovery holding a different
    // container's handle must answer `unknown` — something IS there and we could not use it — rather than
    // merging a verdict some other execution produced.
    const run = runId();
    const half = result("half");
    await stageAgentHalf(store, TENANT, run, half, owed);
    const agentResultDigest = agentHalfDigest(half);
    const judgedTree = contentDigest(SNAPSHOT);
    const attempts = new InMemoryExecutionAttemptStore();

    const invocation = await verifierOperation(
      { attempts, verdicts: store, cleanup: owed, durability: "required" },
      verifierJob({ runId: run, agentResultDigest }),
      async (_job, hooks) => {
        await hooks.authority.reserve({ tenant: TENANT, runId: run, externalJobId: `everdict-verify-${run}` });
        return verdictOf(_job, 1);
      },
    );

    const wrongHandle: RuntimeWorkRef = {
      tenant: TENANT,
      runId: run,
      externalJobId: "everdict-verify-some-other-container",
      ...(invocation.work?.attemptId !== undefined ? { attemptId: invocation.work.attemptId } : {}),
      verifier: { planDigest: "sha256:plan", workspaceDigest: judgedTree, caseId: "c1", agentResultDigest },
    };

    const recovered = await recoverStagedVerdict(store, store, TENANT, run, wrongHandle);
    expect(recovered.kind, "a verdict from another container was merged into this case").toBe("unknown");
  });

  it("SWEEPS the released debt out of the real store, and the zero is read back", async () => {
    // L5 against a store that can actually disagree. The in-memory twin removes from a Map and reports
    // success; here the reconciler's `completed` count is a claim about objects that either are or are not
    // still in MinIO, and the assertion reads them rather than the counter.
    const run = runId();
    const cleanup = new InMemoryIntermediateCleanupStore();
    const swept = result("evidence that outlives its window");
    await stageAgentHalf(store, TENANT, run, swept, cleanup);

    const key = agentHalfKey(TENANT, run, agentHalfDigest(swept));
    expect(await store.get(key), "nothing was staged, so the sweep would prove nothing").toBeDefined();

    await cleanup.releaseForGc(TENANT, storedExecutionId(run));
    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: store, verdicts: store }),
      batch: 500,
    }).tick();

    expect(tick.completed, "the debt was not discharged").toBeGreaterThanOrEqual(1);
    expect(await store.get(key), "the sweep reported a deletion the store did not make").toBeUndefined();
  });
});
