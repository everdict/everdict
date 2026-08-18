import type { ComputeHandle, ExecResult, GradeContext, Score } from "@everdict/contracts";
import { NO_IMAGE } from "@everdict/contracts";
import { isMeasured } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { HarborVerifierGrader } from "./harbor-verifier.js";
import { TestsPassGrader } from "./tests-pass.js";

// A container that behaves like a Harbor task's: the verifier command PUBLISHES its reward to a file and
// then exits 0 whatever the outcome — the shape every real task in harbor-datasets and terminal-bench-2 has.
function harborCompute(opts: { publish?: Record<string, string>; verifierExit?: number }): ComputeHandle {
  const files = new Map<string, string>();
  const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
  return {
    image: NO_IMAGE,
    async exec(cmd: string): Promise<ExecResult> {
      if (cmd.startsWith("mkdir") || cmd.startsWith("chmod")) return ok();
      const cat = /^cat '(.+)'$/.exec(cmd);
      if (cat) {
        const path = cat[1] as string;
        const content = files.get(path);
        return content === undefined
          ? { exitCode: 1, stdout: "", stderr: `cat: ${path}: No such file or directory` }
          : ok(content);
      }
      // the verifier command: publish the reward file(s), then exit 0 like the real scripts do
      for (const [path, content] of Object.entries(opts.publish ?? {})) files.set(path, content);
      return { exitCode: opts.verifierExit ?? 0, stdout: "=== SCRIPT FINISHED ===", stderr: "" };
    },
    async writeFile(path: string, data: string) {
      files.set(path, data);
    },
    async readFile(path: string) {
      return files.get(path) ?? "";
    },
    async dispose() {},
  };
}

function ctx(compute: ComputeHandle): GradeContext {
  return {
    deadlineAt: Date.now() + 60_000,
    case: {
      id: "chess-best-move",
      env: { kind: "repo", source: { path: "/app" } },
      task: "write the best move to /app/move.txt",
      graders: [],
      timeoutSec: 900,
      tags: [],
    },
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "" },
    compute,
  };
}

const primary = (scores: Score[]): Score => {
  const found = scores.find((s) => s.metric === "tests_pass");
  if (!found) throw new Error(`no tests_pass score among ${scores.map((s) => s.metric).join(", ")}`);
  return found;
};

describe("harbor-verifier grader (the reward is a published file, not an exit code)", () => {
  // THE COUNTEREXAMPLE. Given a wrong answer, a Harbor verifier writes reward 0 and exits 0. Reading that
  // run by its exit code — which is what `tests-pass` does, and what the harbor/terminal-bench dataset
  // adapters used to ask for — reports PASS. Both readings are asserted here so the disagreement is the
  // test: if this grader ever starts agreeing with the exit code, this fails.
  it("fails a run whose verifier published reward 0 while exiting 0 — the exit code says pass", async () => {
    const publish = { "/logs/verifier/reward.txt": "0\n" };

    const byExitCode = await new TestsPassGrader("bash /tests/test.sh").grade(ctx(harborCompute({ publish })));
    expect(byExitCode.pass, "the defect: an exit-code reading of a Harbor verifier passes every case").toBe(true);

    const scores = await new HarborVerifierGrader({}).grade(ctx(harborCompute({ publish })));
    const verdict = primary(scores);
    expect(isMeasured(verdict) && verdict.pass, "the published reward is 0, so the case FAILED").toBe(false);
    expect(isMeasured(verdict) && verdict.value).toBe(0);
  });

  it("passes a run whose verifier published reward 1", async () => {
    const scores = await new HarborVerifierGrader({}).grade(
      ctx(harborCompute({ publish: { "/logs/verifier/reward.txt": "1\n" } })),
    );
    const verdict = primary(scores);
    expect(isMeasured(verdict) && verdict.pass).toBe(true);
    expect(isMeasured(verdict) && verdict.value).toBe(1);
  });

  it("a continuous reward is a measurement, and the pass threshold decides the verdict", async () => {
    const publish = { "/logs/verifier/reward.txt": "0.75" };
    const strict = primary(await new HarborVerifierGrader({}).grade(ctx(harborCompute({ publish }))));
    expect(isMeasured(strict) && strict.value).toBe(0.75);
    expect(isMeasured(strict) && strict.pass, "Harbor's own convention is reward == 1 for solved").toBe(false);

    const lenient = primary(
      await new HarborVerifierGrader({ passThreshold: 0.5 }).grade(ctx(harborCompute({ publish }))),
    );
    expect(isMeasured(lenient) && lenient.pass).toBe(true);
  });

  it("reads reward.json in preference to reward.txt and emits one score per reward key", async () => {
    const scores = await new HarborVerifierGrader({}).grade(
      ctx(
        harborCompute({
          publish: {
            "/logs/verifier/reward.json": JSON.stringify({ reward: 1, tests_passed: 12, tests_failed: 0 }),
            "/logs/verifier/reward.txt": "0",
          },
        }),
      ),
    );
    expect(scores).toHaveLength(4);
    const verdict = primary(scores);
    expect(isMeasured(verdict) && verdict.pass, "reward.json wins over the stale reward.txt").toBe(true);
    expect(scores.map((s) => s.metric).sort()).toEqual([
      "reward:reward",
      "reward:tests_failed",
      "reward:tests_passed",
      "tests_pass",
    ]);
  });

  it("namespaces reward keys so a task-authored key cannot land on a constitutional metric name", async () => {
    const scores = await new HarborVerifierGrader({}).grade(
      ctx(harborCompute({ publish: { "/logs/verifier/reward.json": JSON.stringify({ reward: 1, state: 1 }) } })),
    );
    // `state` is a reserved ground-truth name; the reward file's keys come from the benchmark's own shell
    // script, so they arrive under `reward:` and can never be read as a verdict this grader did not make.
    expect(scores.map((s) => s.metric)).toContain("reward:state");
    expect(scores.filter((s) => s.metric === "state")).toHaveLength(0);
  });

  it("a multi-key reward with no `reward` key states no single verdict — unmeasured, not derived", async () => {
    const scores = await new HarborVerifierGrader({}).grade(
      ctx(
        harborCompute({ publish: { "/logs/verifier/reward.json": JSON.stringify({ recall: 0.4, precision: 0.9 }) } }),
      ),
    );
    const verdict = primary(scores);
    expect(verdict.status).toBe("unmeasured");
    expect(verdict.status === "unmeasured" && verdict.reason).toBe("unsupported");
    expect(
      scores
        .filter((s) => isMeasured(s))
        .map((s) => s.metric)
        .sort(),
    ).toEqual(["reward:precision", "reward:recall"]);
  });

  describe("a verifier that published nothing is a GRADER failure, never a zero", () => {
    it("reports unmeasured when no reward file exists, even though the verifier exited 0", async () => {
      const scores = await new HarborVerifierGrader({}).grade(ctx(harborCompute({ publish: {} })));
      const verdict = primary(scores);
      expect(verdict.status).toBe("unmeasured");
      expect(verdict.status === "unmeasured" && verdict.reason).toBe("missing_evidence");
      // The distinction the union exists for: an unmeasured score carries no `value`, so a crashed verifier
      // cannot contribute a 0 to the batch mean.
      expect(scores.some((s) => isMeasured(s))).toBe(false);
    });

    it("reports unmeasured when the reward file is empty or unparseable", async () => {
      for (const content of ["", "   \n", "not-a-number"]) {
        const scores = await new HarborVerifierGrader({}).grade(
          ctx(harborCompute({ publish: { "/logs/verifier/reward.txt": content } })),
        );
        expect(primary(scores).status, `reward.txt = ${JSON.stringify(content)}`).toBe("unmeasured");
      }
    });

    it("reports unmeasured when reward.json is not a {key: number} object", async () => {
      const scores = await new HarborVerifierGrader({}).grade(
        ctx(harborCompute({ publish: { "/logs/verifier/reward.json": JSON.stringify({ reward: "pass" }) } })),
      );
      expect(primary(scores).status).toBe("unmeasured");
    });
  });

  it("materializes the task's tests/ payload into the container before running the verifier", async () => {
    const compute = harborCompute({ publish: { "/logs/verifier/reward.txt": "1" } });
    const written: string[] = [];
    const spy: ComputeHandle = {
      ...compute,
      async writeFile(path: string, data: string) {
        written.push(path);
        await compute.writeFile(path, data);
      },
    };
    await new HarborVerifierGrader({
      files: { "test.sh": "#!/bin/bash\n", "test_outputs.py": "def test_x(): pass\n" },
    }).grade(ctx(spy));
    expect(written).toEqual(["/tests/test.sh", "/tests/test_outputs.py"]);
  });

  it("requires compute — a service/browser harness has none and must not silently score 0", async () => {
    const bare = ctx(harborCompute({}));
    const { compute: _dropped, ...withoutCompute } = bare;
    await expect(new HarborVerifierGrader({}).grade(withoutCompute)).rejects.toThrow(/requires compute/);
  });
});
