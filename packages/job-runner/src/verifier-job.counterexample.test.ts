import type { ComputeHandle, Driver, ExecResult, RepoSnapshot, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runVerifierJob } from "./verifier-job.js";

// ── THE VERDICT IS REACHED SOMEWHERE THE AGENT NEVER WAS (arch-review 56, Wave I) ────────────────────
//
// Wave B closed the task-format disclosure by refusing, and Wave H split the case into the half the agent gets and
// the half that judges it. Neither of those runs anything: the refusal still stands until the judging half has
// somewhere to run that is not the agent's container.
//
// This is that somewhere. A verifier job takes the workspace the agent LEFT — the repo snapshot, which is a
// diff the environment already produces — reconstitutes it in a fresh container, writes the hidden tests
// there, and runs the verifier. What the agent's container never held is the whole point:
//
//   · the tests' bytes (they are in the verifier job, which the agent's lane never serialized);
//   · the verifier's credentials (same);
//   · the reward namespace (a fresh volume in a container the agent could not write to).
//
// So the three boundaries Wave B had to police by discipline — copy the tests late, empty the reward
// directory, refuse traversal — stop being boundaries this code has to maintain. They are two different
// containers. The grader-side guards stay, because defence in depth is free once it is written, but nothing
// depends on their ordering any more.
//
// WHAT THIS FILE PINS is the runner: given a plan and a snapshot, it reaches a verdict from the agent's work
// and nothing else. The control plane's dispatch of it is integration on top.

const SNAPSHOT: RepoSnapshot = {
  kind: "repo",
  diff: "diff --git a/solution.py b/solution.py\n+def solve(): return 42\n",
  changedFiles: ["solution.py"],
  headSha: "abc123",
};

const job = (over: Partial<VerifierJob> = {}): VerifierJob =>
  ({
    runId: "r1",
    tenant: "acme",
    caseId: "c1",
    image: "tasks/repro:1",
    workdir: "/app",
    workspace: SNAPSHOT,
    // A `tests-pass` grader rather than the reward-file one: what this file is about is the RUNNER — restore, empty,
    // grade, dispose — and pinning it to whichever grader id the verifier family currently uses would make it
    // fail on a rename that has nothing to do with the property. Which graders are private is Wave H's
    // question, and it is asserted there.
    plan: {
      digest: "sha256:plan",
      graders: [{ id: "tests-pass", config: { cmd: "test -f /app/solution.py" } }],
    },
    ...over,
  }) as unknown as VerifierJob;

// A container that records what it was asked to do, and answers `cat` from the files written into it.
function fakeDriver(): { driver: Driver; execs: string[]; files: Map<string, string> } {
  const execs: string[] = [];
  const files = new Map<string, string>();
  const compute: ComputeHandle = {
    id: "verifier-1",
    async exec(cmd: string): Promise<ExecResult> {
      execs.push(cmd);
      const cat = /^cat '?([^']+)'?$/.exec(cmd.trim());
      if (cat) {
        const held = files.get(cat[1] as string);
        return held === undefined
          ? { exitCode: 1, stdout: "", stderr: "No such file" }
          : { exitCode: 0, stdout: held, stderr: "" };
      }
      // The verifier's own command: it passes only if the agent's work was actually restored.
      if (cmd.includes("test -f /app/solution.py"))
        return files.has("/app/solution.py")
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      // `git apply` — model the restore by materializing the file the diff names.
      if (cmd.includes("git apply")) files.set("/app/solution.py", "def solve(): return 42");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile(path: string, data: string) {
      files.set(path, data);
    },
    async readFile(path: string) {
      const held = files.get(path);
      if (held === undefined) throw new Error(`no such file: ${path}`);
      return held;
    },
    async snapshot() {
      return SNAPSHOT as never;
    },
    async dispose() {
      /* nothing to release */
    },
  } as unknown as ComputeHandle;
  return {
    execs,
    files,
    driver: {
      async provision() {
        return compute;
      },
    } as unknown as Driver,
  };
}

// RED as of 9f610f6c, observed:
//   Cannot find module './verifier-job.js'
describe("[R56 WAVE-I COUNTEREXAMPLE #10 — CLOSED] a verifier job judges the work the agent left", () => {
  it("reconstitutes the agent's workspace and reaches the verdict from it", async () => {
    const world = fakeDriver();
    const scores = await runVerifierJob(job(), { driver: world.driver });

    // The agent's diff was applied — the verdict is about the work, not about an empty checkout.
    expect(
      world.execs.some((c) => c.includes("git apply") || c.includes("patch")),
      "the workspace was never restored",
    ).toBe(true);
    const primary = scores.find((s) => s.metric === "tests_pass");
    expect(primary !== undefined && "value" in primary ? primary.value : undefined).toBe(1);
  });

  it("starts from an empty reward namespace it created itself", async () => {
    // The container is fresh, so there is nothing of the agent's to clear — which is exactly the property the
    // grader-side `rm -rf` was standing in for. Asserted so a future change that reuses the agent's compute
    // has to explain itself.
    const world = fakeDriver();
    world.files.set("/logs/verifier/reward.json", JSON.stringify({ reward: 1 }));
    await runVerifierJob(job(), { driver: world.driver });
    expect(
      world.execs.some((c) => /\brm\b/.test(c) && c.includes("/logs/verifier")),
      "the verifier trusted a reward namespace it had not emptied",
    ).toBe(true);
  });

  it("REFUSES a job whose plan carries no deciding grader — there is nothing to be a verifier for", async () => {
    // A verifier job with an empty plan would provision a container, run nothing, and report an absence as a
    // measurement. `verifierPlanOf` answers `undefined` for such a case, so reaching here means a dispatcher
    // built the job anyway.
    const world = fakeDriver();
    await expect(
      runVerifierJob(job({ plan: { digest: "sha256:empty", graders: [] } } as never), { driver: world.driver }),
    ).rejects.toThrow(/no deciding grader|nothing to verify/i);
  });

  it("releases its compute even when the verifier throws", async () => {
    let released = 0;
    const failing = {
      async provision() {
        return {
          id: "v",
          async exec(): Promise<ExecResult> {
            throw new Error("cluster died mid-verify");
          },
          async writeFile() {
            /* noop */
          },
          async readFile(): Promise<string> {
            throw new Error("no");
          },
          async dispose() {
            released += 1;
          },
        } as unknown as ComputeHandle;
      },
    } as unknown as Driver;

    await runVerifierJob(job(), { driver: failing }).catch(() => undefined);
    expect(released, "a verifier container outlived the job that made it").toBe(1);
  });
});
