import type { ComputeHandle, Driver, ExecResult, RepoSnapshot, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runVerifierJob } from "./verifier-job.js";

// ── A DIFF IS ONLY THE AGENT'S WORK ON THE BASELINE IT WAS COMPUTED AGAINST (arch-review 58 P1) ──────
//
// The verifier reconstitutes the agent's workspace by `git apply`-ing the snapshot diff into a FRESH
// container built from the task's image. That is what makes a second container affordable — no image commit,
// no volume export. It also means the restore has a premise: that the tree the patch lands on is the tree the
// patch was computed against.
//
// Nothing checked it. `RepoSnapshot.headSha` is exactly that premise — `git rev-parse HEAD` in the agent's
// container, recorded at snapshot time — and it travelled to the verifier unread. A task image behind a
// mutable tag, a seed that clones a branch tip, a re-pin between the two dispatches: the diff then lands on a
// different commit, and `git apply` is a fuzzy tool. It matches on context, so it does not reliably fail —
// it succeeds and produces a tree the agent never made.
//
// The verdict is then real evidence about the wrong world, which is the worst of the three outcomes
// available (right answer / visible failure / confident wrong answer). A refusal here becomes
// `tests_pass: unmeasured` upstream, which says the case was not judged.
//
// `headSha` is EMPTY for a workdir that is not a git repository at all — `git rev-parse HEAD` fails there and
// the environment records the empty string. That is a real state, not a missing one: there is no baseline to
// confirm, and demanding one would refuse a path that works today.
//
// Seen RED with the check removed, observed:
//   the verifier judged a tree the agent never produced: expected [Function] to throw an error

const DIFF = "diff --git a/solution.py b/solution.py\n+def solve(): return 42\n";

const snapshotAt = (headSha: string): RepoSnapshot => ({
  kind: "repo",
  diff: DIFF,
  changedFiles: ["solution.py"],
  headSha,
});

const job = (workspace: RepoSnapshot): VerifierJob =>
  ({
    runId: "r1",
    tenant: "acme",
    caseId: "c1",
    image: "tasks/repro:1",
    workdir: "/app",
    workspace,
    plan: { digest: "sha256:plan", graders: [{ id: "tests-pass", config: { cmd: "test -f /app/solution.py" } }] },
    timeoutSec: 60,
  }) as unknown as VerifierJob;

// A container whose checkout sits at `head`, and which reports it the way git does.
function containerAt(head: string | "not-a-repo"): { driver: Driver; execs: string[] } {
  const execs: string[] = [];
  const files = new Set<string>();
  const compute = {
    id: "verifier-1",
    async exec(cmd: string): Promise<ExecResult> {
      execs.push(cmd);
      if (cmd.includes("rev-parse HEAD"))
        return head === "not-a-repo"
          ? { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }
          : { exitCode: 0, stdout: `${head}\n`, stderr: "" };
      if (cmd.includes("git apply")) {
        files.add("/app/solution.py");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("test -f /app/solution.py"))
        return files.has("/app/solution.py")
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  } as unknown as ComputeHandle;
  return {
    execs,
    driver: {
      async provision() {
        return compute;
      },
    } as unknown as Driver,
  };
}

describe("[R58 COUNTEREXAMPLE] a verifier judges the baseline the agent worked from", () => {
  it("REFUSES when the container's checkout is a different commit", async () => {
    const world = containerAt("deadbee");
    await expect(
      runVerifierJob(job(snapshotAt("abc123")), { driver: world.driver }),
      "the verifier judged a tree the agent never produced",
    ).rejects.toThrow(/baseline|headSha|abc123/i);
  });

  it("judges normally when the checkout matches", async () => {
    const world = containerAt("abc123");
    const scores = await runVerifierJob(job(snapshotAt("abc123")), { driver: world.driver });
    const primary = scores.find((s) => s.metric === "tests_pass");
    expect(primary !== undefined && "value" in primary ? primary.value : undefined).toBe(1);
    expect(world.execs.some((c) => c.includes("rev-parse HEAD"))).toBe(true);
  });

  it("REFUSES when the container cannot say what it is checked out at", async () => {
    // The snapshot claims a baseline and the container cannot confirm one. "Could not find out" is not
    // "it matches" (rule `protocol` L2) — and this is a container that was supposed to hold that repository.
    const world = containerAt("not-a-repo");
    await expect(runVerifierJob(job(snapshotAt("abc123")), { driver: world.driver })).rejects.toThrow();
  });

  it("does NOT demand a baseline the snapshot never had", async () => {
    // A workdir that is not a git repository records `headSha: ""`. There is nothing to confirm, and
    // refusing here would break a path that works.
    const world = containerAt("not-a-repo");
    const scores = await runVerifierJob(job(snapshotAt("")), { driver: world.driver });
    expect(scores.some((s) => s.metric === "tests_pass")).toBe(true);
    expect(world.execs.some((c) => c.includes("rev-parse HEAD"))).toBe(false);
  });
});
