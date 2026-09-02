import { BadRequestError, DatasetSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { adapterToDataset, importBenchmark } from "./catalog.js";
import { BenchmarkAdapterSpecSchema, fetchSourceRows } from "./spec.js";
import { parseTerminalBenchTasks } from "./terminal-bench.js";
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

  // A v2 task's `test.sh` writes the reward to /logs/verifier/reward.{txt,json} and exits 0 either way, so
  // the exit-code reading marks every case as passing (see graders/src/reward-file.ts). The default must
  // therefore be the reward file — the exit-code grader stays reachable ONLY for a v1-era task set that
  // explicitly asks for it.
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

describe("terminalBenchTaskToCase — the world the task declares", () => {
  // An adapter that drops the task's environment declaration silently changes what the benchmark measures:
  // the case runs in a default box on the open internet and its score is filed as the answer to a question
  // about a 4 GB offline machine. The execution site can only enforce or refuse a declaration that survived
  // the import (rule `drivers`).
  it("carries cpus/memory/gpus over as resources, converting whole cores to millicores", () => {
    const c = terminalBenchTaskToCase({
      id: "build-heavy",
      instruction: "compile it",
      image: "img:1",
      cpus: 4,
      memoryMb: 8192,
      gpus: 1,
    });
    expect(c.resources).toEqual({ cpu: 4000, memoryMb: 8192, gpu: 1 });
  });

  it("reads gpus = 0 as 'no GPU', not as a request for zero of them", () => {
    const c = terminalBenchTaskToCase({ id: "t", instruction: "x", image: "img:1", cpus: 1, gpus: 0 });
    expect(c.resources).toEqual({ cpu: 1000 });
  });

  it("translates the network vocabulary, and leaves 'public' absent rather than declared", () => {
    const offline = terminalBenchTaskToCase({ id: "t", instruction: "x", image: "img:1", networkMode: "no-network" });
    expect(offline.network).toEqual({ mode: "none", allowedHosts: [] });

    const allow = terminalBenchTaskToCase({
      id: "t",
      instruction: "x",
      image: "img:1",
      networkMode: "allowlist",
      allowedHosts: ["pypi.org"],
    });
    expect(allow.network).toEqual({ mode: "allowlist", allowedHosts: ["pypi.org"] });

    // `public` is what every case got before the field existed — recording it as a deliberate choice would
    // make "the task said nothing" and "the task chose the open internet" indistinguishable.
    const open = terminalBenchTaskToCase({ id: "t", instruction: "x", image: "img:1", networkMode: "public" });
    expect(open.network).toBeUndefined();
  });

  it("declares nothing when the task declared nothing", () => {
    const c = terminalBenchTaskToCase({ id: "t", instruction: "x", image: "img:1" });
    expect(c.resources).toBeUndefined();
    expect(c.network).toBeUndefined();
  });
});

// ── THE INGESTION EDGE (docs/architecture/standard-task-formats.md, slices 2-3) ───────────────────────
//
// Text → tasks → a dataset, through the same door `POST /datasets/import` uses. What these pin is the pair
// of refusals: a document this cannot read must not import as an EMPTY task set (a dataset with no cases and
// no error is the worst outcome available), and a task whose image cannot be resolved must not import as a
// case nothing can run.
describe("parseTerminalBenchTasks — the shapes a caller actually has", () => {
  const task = (id: string) => ({ id, instruction: `do ${id}`, image: `ghcr.io/acme/${id}:1` });

  it("reads a JSON array, a { tasks } document and one task per line alike", () => {
    const two = [task("a"), task("b")];
    expect(parseTerminalBenchTasks(JSON.stringify(two)).map((t) => t.id)).toEqual(["a", "b"]);
    expect(parseTerminalBenchTasks(JSON.stringify({ tasks: two })).map((t) => t.id)).toEqual(["a", "b"]);
    expect(parseTerminalBenchTasks(two.map((t) => JSON.stringify(t)).join("\n")).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("refuses an empty, unreadable or non-task document by name — never an empty task set", () => {
    expect(() => parseTerminalBenchTasks("   ")).toThrow(/empty/);
    expect(() => parseTerminalBenchTasks("{not json")).toThrow(/not valid JSON/);
    expect(() => parseTerminalBenchTasks('{"cases": []}')).toThrow(/is not a task/);
    expect(() => parseTerminalBenchTasks("[]")).toThrow(/zero tasks/);
    expect(() => parseTerminalBenchTasks(JSON.stringify([{ id: "a" }]))).toThrow(/task #1 is not a task/);
  });

  it("imports a task set through the benchmark door, resolving each image from the template", async () => {
    const dataset = await importBenchmark(
      {
        id: "tb",
        description: "a task set",
        category: "coding",
        defaultVersion: "1.0.0",
        source: { kind: "terminal-bench", imageTemplate: "ghcr.io/acme/tb/{id}:v1" },
        mapping: { idField: "id", taskField: "instruction" },
      },
      { id: "tb", version: "1.0.0" },
      { text: JSON.stringify([{ id: "hello", instruction: "say hello" }]) },
    );
    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0]?.image).toBe("ghcr.io/acme/tb/hello:v1");
    expect(dataset.cases[0]?.graders?.[0]?.id).toBe("reward-file");
    // …and a task with no image and no template is refused, not imported as a case nothing can run.
    await expect(
      importBenchmark(
        {
          id: "tb",
          description: "a task set",
          category: "coding",
          defaultVersion: "1.0.0",
          source: { kind: "terminal-bench" },
          mapping: { idField: "id", taskField: "instruction" },
        },
        { id: "tb", version: "1.0.0" },
        { text: JSON.stringify([{ id: "hello", instruction: "say hello" }]) },
      ),
    ).rejects.toThrow();
  });

  it("previews the set through the same parse the import uses", async () => {
    const rows = await fetchSourceRows(
      { kind: "terminal-bench" },
      { text: JSON.stringify([task("a"), task("b"), task("c")]), limit: 2 },
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

// A mapping is a ROW-MAPPED source's, and only that (`BenchmarkAdapterSpecSchema`): requiring one for the
// task-set source would force every caller to invent field names nothing reads.
describe("the mapping belongs to the source that has rows", () => {
  it("a terminal-bench recipe registers with no mapping; a jsonl one without a mapping is refused", () => {
    const base = { id: "tb", version: "1.0.0", category: "coding" as const };
    expect(
      BenchmarkAdapterSpecSchema.safeParse({
        ...base,
        source: { kind: "terminal-bench", imageTemplate: "ghcr.io/acme/tb/{id}:v1" },
      }).success,
    ).toBe(true);
    const jsonl = BenchmarkAdapterSpecSchema.safeParse({ ...base, source: { kind: "jsonl" } });
    expect(jsonl.success).toBe(false);
    expect(jsonl.success === false && jsonl.error.issues[0]?.message).toContain("mapped row by row");
  });

  it("and a row-mapped adapter that reaches the mapper with no mapping refuses instead of emitting blank cases", () => {
    expect(() =>
      adapterToDataset(
        { id: "x", description: "x", category: "qa", defaultVersion: "1", source: { kind: "jsonl" } },
        [{ id: "a", task: "b" }],
        { id: "x", version: "1.0.0" },
      ),
    ).toThrow(/declares no mapping/);
  });
});

// The LINEAGE a task-set import stamps. A dataset's `producedBy.source` is the one field answering "where did
// these cases come from", and a fall-through that calls a task set "jsonl" answers it wrong — the shape this
// batch replaced, stamped as the shape it replaced.
describe("a task set's provenance says it is one", () => {
  it("the mapper stamps Terminal-Bench provenance on the dataset it builds", () => {
    const ds = terminalBenchToDataset([{ id: "hello", instruction: "hi", image: "img:1" }], {
      id: "tb",
      version: "1.0.0",
    });
    expect(ds.producedBy).toMatchObject({ via: "spec", id: "terminal-bench" });
    expect(ds.producedBy?.origin?.code).toContain("terminal-bench");
  });
});
