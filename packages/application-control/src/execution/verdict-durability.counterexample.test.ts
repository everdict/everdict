import type { CaseResult, RuntimeWorkRef, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { CaseResultSchema, VerifierInvocationSchema } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import {
  type AgentHalfStore,
  agentHalfDigest,
  recoverStagedVerdict,
  recoverVerifiedCase,
  stageAgentHalf,
} from "./agent-half.js";
import { verifierOperation } from "./verifier-operation.js";

// ── DURABLE INPUT HALF ≠ DURABLE TWO-PHASE OPERATION (arch-review 64 P0) ────────────────────────────
//
// arch-review 60 made the AGENT's half durable: staged as immutable bytes before the second container is
// dispatched, so a crash between the halves has something to merge into. The verdict itself was never staged.
//
// A verifier container is reclaimed by its lane the moment the logs are parsed, so from that moment the
// `VerifierInvocation` — scores, image provenance, canonical handle, digests — lived in exactly one place:
// the process's memory, until the canonical settlement. A crash in that window left
//
//     agent half        staged
//     verifier Job      deleted
//     verdict bytes     nowhere
//
// and the recovery, finding the verifier's object absent, re-ran the WHOLE case. A constitutional decision
// that had already been computed and paid for was tied to the lifetime of the process that computed it.
//
// The attempt row is not verdict storage either: it can say `verdict_produced` while the only copy of the
// verdict is gone. The row records that a phase happened; the bytes ARE the phase.
//
// Seen RED before the verdict was staged, observed:
//   the verdict was gone with its container, so the whole case re-ran: expected 'absent' to be 'merged'

const RUN = "evd-run-r1";

// PARSED BY THE CONTRACT, not cast past it. `readAgentHalf` runs `CaseResultSchema.parse` on what it reads
// back — these bytes crossed a restart — so a hand-shaped fixture that does not validate makes the recovery
// answer `unknown` for a reason that has nothing to do with the defect. The first draft of this file did
// exactly that and reported a green-adjacent failure (rule `testing`: a fixture must reach the predicate).
const AGENT_HALF: CaseResult = CaseResultSchema.parse({
  caseId: "c1",
  harness: "cc@1.0.0",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "the agent ran" }],
  scores: [{ graderId: "steps", metric: "steps", value: 7 }],
  snapshot: { kind: "repo", diff: "diff --git a/x b/x", changedFiles: [], base: "base-sha", headSha: "head-sha" },
});

const JOB: VerifierJob = {
  runId: RUN,
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: AGENT_HALF.snapshot,
  plan: { digest: "sha256:plan", graders: [] },
  timeoutSec: 60,
  // WHICH half this verdict is about — the coordinate both the stage and the recovery are keyed by.
  agentResultDigest: agentHalfDigest(AGENT_HALF),
} as unknown as VerifierJob;

const INVOCATION: VerifierInvocation = VerifierInvocationSchema.parse({
  planDigest: "sha256:plan",
  workspaceDigest: contentDigest(AGENT_HALF.snapshot),
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
});

// The handle a recovery finds on the attempt ledger for the judging half.
const VERIFIER_HANDLE: RuntimeWorkRef = {
  tenant: "acme",
  runId: RUN,
  externalJobId: "everdict-verify-c1",
  verifier: {
    planDigest: "sha256:plan",
    workspaceDigest: contentDigest(AGENT_HALF.snapshot),
    caseId: "c1",
    agentResultDigest: agentHalfDigest(AGENT_HALF),
  },
} as unknown as RuntimeWorkRef;

// An object store, deliberately shared between the two key spaces exactly as production shares it.
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

// The world just before the crash: the agent's half staged, the verifier run to completion through the real
// operation (which stages the verdict and stamps the row), and then the process dies.
const upToTheCrash = async () => {
  const artifacts = store();
  const attempts = new InMemoryExecutionAttemptStore();
  await stageAgentHalf(artifacts, "acme", RUN, AGENT_HALF);

  await verifierOperation({ attempts, verdicts: artifacts }, JOB, async (job, hooks) => {
    const work = { tenant: job.tenant, runId: job.runId, externalJobId: "everdict-verify-c1" };
    await hooks.authority.reserve(work);
    await hooks.authority.activate(work);
    // …and the lane reclaims its container here, which is why the bytes must already be somewhere.
    return INVOCATION;
  });

  return { artifacts, attempts };
};

describe("[R64 COUNTEREXAMPLE] a verdict outlives the process that produced it", () => {
  it("finishes the case from the two staged halves, with no live object", async () => {
    const { artifacts } = await upToTheCrash();

    // The crash. Nothing survives but the object store — and the verifier's Job is long gone, which is what
    // makes adoption answer `absent` and what used to send the case back for a full re-drive.
    const recovered = await recoverStagedVerdict(artifacts, artifacts, "acme", RUN, VERIFIER_HANDLE);

    expect(recovered.kind, "the verdict was gone with its container, so the whole case re-ran").toBe("merged");
    if (recovered.kind !== "merged") return;
    // …and it is the SAME document the in-line path would have produced from the same two halves.
    // …and it is the SAME document the in-line path produces from the same two halves. Compared against the
    // production merge rather than a field list, so a merge that grows a field cannot pass here by omission.
    const inline = store();
    await stageAgentHalf(inline, "acme", RUN, AGENT_HALF);
    const normal = await recoverVerifiedCase(inline, "acme", RUN, VERIFIER_HANDLE, INVOCATION);
    expect(normal.kind).toBe("merged");
    if (normal.kind !== "merged") return;
    expect(recovered.result).toEqual(normal.result);
  });

  it("says `absent` when nothing was staged — a re-drive, not a guess", async () => {
    // The control. A deployment with no artifact store, an older writer, a staging failure: the honest answer
    // is that there is nothing to recover, and the case re-drives exactly as it did before this existed.
    const empty = store();
    const recovered = await recoverStagedVerdict(empty, empty, "acme", RUN, VERIFIER_HANDLE);
    expect(recovered.kind).toBe("absent");
  });

  it("says `unknown` when the store will not answer — deciding nothing", async () => {
    // A read that failed is not an empty one (rule `protocol` L2). Answering `absent` here would re-run a
    // case whose verdict may be sitting in the store, which is the double-spend the union exists to prevent.
    const { artifacts } = await upToTheCrash();
    const unreadable: AgentHalfStore = {
      put: artifacts.put.bind(artifacts),
      remove: artifacts.remove.bind(artifacts),
      async get() {
        throw new Error("the artifact store is unreachable");
      },
    };
    const recovered = await recoverStagedVerdict(artifacts, unreadable, "acme", RUN, VERIFIER_HANDLE);
    expect(recovered.kind, "an unreadable store was read as a case with no verdict").toBe("unknown");
  });

  it("stages the verdict under its OWN key, beside the half rather than over it", async () => {
    // The two documents are about the same execution and are not the same bytes. One key, one document —
    // sharing a key would make the later write destroy the earlier (the hazard `agentHalfKey`'s own history
    // is a record of).
    const { artifacts } = await upToTheCrash();
    const keys = artifacts.keys();
    expect(keys.filter((k) => k.startsWith("agent-half/"))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith("verifier-verdict/"))).toHaveLength(1);
  });
});
