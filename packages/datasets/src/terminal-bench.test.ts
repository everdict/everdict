import { BadRequestError, DatasetSchema } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { terminalBenchTaskToCase, terminalBenchToDataset } from "./terminal-bench.js";

describe("terminalBenchTaskToCase", () => {
  it("maps a full task → EvalCase (image env + instruction + tests-pass + difficulty tag)", () => {
    const c = terminalBenchTaskToCase({
      id: "fix-git-merge",
      instruction: "Resolve the merge conflict and make the tests pass.",
      image: "ghcr.io/acme/tb/fix-git-merge:v1",
      testCommand: "bash /tests/run-tests.sh",
      workdir: "/workspace",
      difficulty: "hard",
      tags: ["git", "vcs"],
      timeoutSec: 1200,
    });
    expect(c.id).toBe("fix-git-merge");
    expect(c.task).toBe("Resolve the merge conflict and make the tests pass.");
    expect(c.image).toBe("ghcr.io/acme/tb/fix-git-merge:v1");
    expect(c.env).toEqual({ kind: "repo", source: { path: "/workspace" } }); // in-image, no clone
    expect(c.graders).toEqual([{ id: "tests-pass", config: { cmd: "bash /tests/run-tests.sh" } }]);
    expect(c.tags).toEqual(["hard", "git", "vcs"]); // difficulty prepended
    expect(c.timeoutSec).toBe(1200);
  });

  it("applies defaults for testCommand, workdir, and timeout when omitted", () => {
    const c = terminalBenchTaskToCase({ id: "t1", instruction: "do X", image: "img:1" });
    expect(c.env).toEqual({ kind: "repo", source: { path: "/app" } });
    expect(c.graders).toEqual([{ id: "tests-pass", config: { cmd: "bash /tests/run-tests.sh" } }]);
    expect(c.timeoutSec).toBe(900);
    expect(c.tags).toEqual([]);
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
    expect(ds.cases).toHaveLength(2);
    expect(ds.cases[0]?.image).toBe("reg.example.com/tb/a:v1");
    expect(ds.cases[0]?.tags).toEqual(["easy"]);
    expect(ds.cases[1]?.image).toBe("reg.example.com/tb/b:v1");
    expect(ds.cases[1]?.graders).toEqual([{ id: "tests-pass", config: { cmd: "pytest -q" } }]);
    expect(ds.cases[1]?.tags).toEqual(["python"]);
  });

  it("surfaces a task with no resolvable image as a BadRequestError (not a silent skip)", () => {
    expect(() => terminalBenchToDataset([{ id: "a", instruction: "x" }], { id: "d", version: "1.0.0" })).toThrow(
      BadRequestError,
    );
  });
});
