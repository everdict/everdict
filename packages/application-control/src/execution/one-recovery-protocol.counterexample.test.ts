import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseResult, RuntimeWorkRef, VerifierInvocation } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { agentHalfDigest, agentHalfKey, recoverVerifiedCase } from "./agent-half.js";

// ── ONE TWO-PHASE PROTOCOL, ONE WAY TO FINISH IT (arch-review 62 P1) ────────────────────────────────
//
// A case with a private verifier is two units, and the agent's half is staged as immutable bytes before the
// second container exists so a crash between them is recoverable. `mergeVerifierPass` was shared from the
// start — and the way you REACH it was not:
//
//   standalone recovery   adopted a verifier → read the staged half → merged
//   batch RecoveryPlanner adopted a verifier → skipped it → re-drove the whole case
//
// Both are safe; only one is finished. The batch owner paid for a verifier container, threw its verdict away,
// and re-ran the agent as well — over evidence that was already on file. Two owners of one protocol, and the
// second learned half of it, which is the same shape as a lane that never learned the phase (see
// `inert-recovery.counterexample.test.ts`) with the roles of writer and reader swapped.
//
// So the lookup is one exported function, not a paragraph spelled twice, and this file asserts both halves:
// what it answers, and that both owners go through it.
//
// Seen RED before the sharing, observed:
//   the batch recovery discarded a verdict whose container had already run: expected [] to contain
//   'recoverVerifiedCase'

const HALF: CaseResult = {
  caseId: "c1",
  harness: "agent@1",
  trace: [],
  scores: [],
  snapshot: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
};

const DIGEST = agentHalfDigest(HALF);

// The handle a recovery holds: it names which PHYSICAL half this verdict is about, which is what
// `workspaceDigest` alone cannot say (two attempts can leave the same tree).
const WORK: RuntimeWorkRef = {
  tenant: "acme",
  runId: "evd-run-r1",
  externalJobId: "everdict-verify-c1",
  verifier: {
    planDigest: "sha256:plan",
    workspaceDigest: "unused-here",
    caseId: "c1",
    agentResultDigest: DIGEST,
  },
};

const VERDICT = {
  planDigest: "sha256:plan",
  // Computed the way `mergeVerifierPass` computes it, so this fixture REACHES the merge instead of bouncing
  // off its identity check — a fixture that never reaches the code under test asserts nothing.
  workspaceDigest: contentDigest(HALF.snapshot),
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
} as unknown as VerifierInvocation;

const store = (bytes?: Uint8Array) => ({
  put: async () => "ref",
  get: async (key: string) => (key === agentHalfKey("acme", "evd-run-r1", DIGEST) ? bytes : undefined),
});

describe("[R62 COUNTEREXAMPLE] a recovered verdict is finished the same way by every owner", () => {
  it("MERGES the staged half the handle names", async () => {
    const staged = store(new TextEncoder().encode(JSON.stringify(HALF)));
    const out = await recoverVerifiedCase(staged, "acme", "evd-run-r1", WORK, VERDICT);

    expect(out.kind, "a verdict whose half was on file could not be finished").toBe("merged");
    if (out.kind !== "merged") throw new Error("unreachable");
    expect(out.result.harness, "the merge produced something other than the agent's own result").toBe("agent@1");
    expect(out.result.verifier, "the verdict did not reach the merged result").toBeDefined();
  });

  it("is ABSENT when the handle cannot name which half it judged", async () => {
    // An older writer, or a deployment that stages nothing. Re-driving is the honest answer; merging against
    // whatever is at a shared key is the defect this coordinate closes.
    const staged = store(new TextEncoder().encode(JSON.stringify(HALF)));
    const bare: RuntimeWorkRef = { ...WORK, verifier: { ...WORK.verifier, agentResultDigest: undefined } as never };
    expect((await recoverVerifiedCase(staged, "acme", "evd-run-r1", bare, VERDICT)).kind).toBe("absent");
  });

  it("stays UNKNOWN when the store will not say", async () => {
    const broken = {
      put: async () => "ref",
      get: async () => {
        throw new Error("artifact store unavailable");
      },
    };
    const out = await recoverVerifiedCase(broken, "acme", "evd-run-r1", WORK, VERDICT);
    expect(out.kind, "an unreadable store was read as 'there is no agent half'").toBe("unknown");
  });

  it("BOTH recovery owners reach the merge through it", () => {
    // The structural half. The behaviour above is only worth having if every owner uses it — and the way this
    // drifted the first time was a second owner quietly doing less, with nothing failing. A source assertion
    // is what catches a third owner, or a regression to a private path (the idiom TRUST-120 uses for the
    // same reason).
    const root = join(import.meta.dirname, "..", "..", "..", "..");
    const owners = [
      join(root, "apps", "api", "src", "composition", "runtime-access.ts"),
      join(root, "packages", "application-control", "src", "scorecard", "recovery-planner.ts"),
    ];
    for (const file of owners) {
      const source = readFileSync(file, "utf8");
      // TWO claims, because neutralizing the first one alone left this green: a branch can be disabled while
      // the call it guards stays in the file, which is the difference between checking a protocol and
      // checking the line next to it (rule `testing`, and the mutation that caught it).
      expect(source, `${file} recovers a verifier verdict without the shared lookup`).toContain("recoverVerifiedCase");
      expect(source, `${file} never takes the branch where a verdict is what answered`).toContain(
        'stage === "verifier"',
      );
    }
  });
});
