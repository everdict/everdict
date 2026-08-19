import { BadRequestError, DatasetSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { terminalBenchTaskToCase, terminalBenchToDataset } from "./terminal-bench.js";

describe("terminalBenchTaskToCase", () => {
  it("maps a full task → EvalCase (image env + instruction + reward-file verifier + difficulty tag)", () => {
    const c = terminalBenchTaskToCase({
      id: "fix-git-merge",
      instruction: "Resolve the merge conflict and make the tests pass.",
      image: "ghcr.io/acme/tb/fix-git-merge:v1",
      testCommand: "bash /tests/test.sh",
      tests: { "test.sh": "#!/bin/bash\n" },
      verifierTimeoutSec: 900,
      workdir: "/workspace",
      difficulty: "hard",
      tags: ["git", "vcs"],
      timeoutSec: 1200,
    });
    expect(c.id).toBe("fix-git-merge");
    expect(c.task).toBe("Resolve the merge conflict and make the tests pass.");
    expect(c.image).toBe("ghcr.io/acme/tb/fix-git-merge:v1");
    expect(c.env).toEqual({ kind: "repo", source: { path: "/workspace" } }); // in-image, no clone
    expect(c.graders).toEqual([
      {
        id: "reward-file",
        config: {
          cmd: "bash /tests/test.sh",
          cwd: "/workspace",
          files: { "test.sh": "#!/bin/bash\n" },
          timeoutSec: 900,
        },
      },
    ]);
    expect(c.tags).toEqual(["hard", "git", "vcs"]); // difficulty prepended
    expect(c.timeoutSec).toBe(1200);
  });

  it("applies defaults for testCommand, workdir, and timeout when omitted", () => {
    const c = terminalBenchTaskToCase({ id: "t1", instruction: "do X", image: "img:1" });
    expect(c.env).toEqual({ kind: "repo", source: { path: "/app" } });
    expect(c.graders).toEqual([{ id: "reward-file", config: { cmd: "bash /tests/test.sh", cwd: "/app" } }]);
    expect(c.timeoutSec).toBe(900);
    expect(c.tags).toEqual([]);
  });

  // A Terminal-Bench 2.0 task's `test.sh` writes the reward to
  // /logs/verifier/reward.{txt,json} and exits 0 either way, so the exit-code reading passes every case
  // (see reward-file.ts). The default must therefore be the reward file — the exit-code
  // grader stays reachable ONLY for a v1-era task set that explicitly asks for it.
  it("defaults to the published reward, and only an explicit verdict:'exit-code' brings back the v1 reading", () => {
    const v2 = terminalBenchTaskToCase({ id: "t", instruction: "x", image: "i:1" });
    expect(v2.graders.map((g) => g.id)).toEqual(["reward-file"]);

    const v1 = terminalBenchTaskToCase({
      id: "t",
      instruction: "x",
      image: "i:1",
      verdict: "exit-code",
      testCommand: "bash /tests/run-tests.sh",
    });
    expect(v1.graders).toEqual([{ id: "tests-pass", config: { cmd: "bash /tests/run-tests.sh" } }]);
  });

  it("resolves the image from an imageTemplate ({id}) when the task has none", () => {
    const c = terminalBenchTaskToCase(
      { id: "hello-world", instruction: "print hello" },
      { imageTemplate: "ghcr.io/acme/tb-tasks/{id}:v2" },
    );
    expect(c.image).toBe("ghcr.io/acme/tb-tasks/hello-world:v2");
  });

  it("a per-task image wins over the imageTemplate", () => {
    const c = terminalBenchTaskToCase(
      { id: "t", instruction: "x", image: "explicit:9" },
      { imageTemplate: "ghcr.io/acme/tb-tasks/{id}:v2" },
    );
    expect(c.image).toBe("explicit:9");
  });

  it("throws when neither an image nor an imageTemplate resolves (Everdict references images, never builds)", () => {
    expect(() => terminalBenchTaskToCase({ id: "t", instruction: "x" })).toThrow(BadRequestError);
  });

  it("rejects a malformed task (missing instruction) at the boundary", () => {
    expect(() => terminalBenchTaskToCase({ id: "t", image: "img:1" })).toThrow();
  });
});

describe("terminalBenchToDataset", () => {
  it("maps a task set → a valid Everdict Dataset with a shared imageTemplate", () => {
    const ds = terminalBenchToDataset(
      [
        { id: "a", instruction: "task a", difficulty: "easy" },
        { id: "b", instruction: "task b", testCommand: "pytest -q", tags: ["python"] },
      ],
      { id: "terminal-bench", version: "1.0.0", description: "T-Bench core", tags: ["coding"] },
      { imageTemplate: "reg.example.com/tb/{id}:v1" },
    );
    expect(DatasetSchema.safeParse(ds).success).toBe(true);
    expect(ds.id).toBe("terminal-bench");
    expect(ds.producedBy?.id).toBe("terminal-bench"); // lineage stamped
    expect(ds.cases).toHaveLength(2);
    expect(ds.cases[0]?.image).toBe("reg.example.com/tb/a:v1");
    expect(ds.cases[0]?.tags).toEqual(["easy"]);
    expect(ds.cases[1]?.image).toBe("reg.example.com/tb/b:v1");
    expect(ds.cases[1]?.graders).toEqual([{ id: "reward-file", config: { cmd: "pytest -q", cwd: "/app" } }]);
    expect(ds.cases[1]?.tags).toEqual(["python"]);
  });

  it("surfaces a task with no resolvable image as a BadRequestError (not a silent skip)", () => {
    expect(() => terminalBenchToDataset([{ id: "a", instruction: "x" }], { id: "d", version: "1.0.0" })).toThrow(
      BadRequestError,
    );
  });
});
