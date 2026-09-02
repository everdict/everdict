import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTerminalBenchTasks } from "@everdict/datasets";
import { describe, expect, it } from "vitest";
import { walkTaskSet } from "./task-set.js";
import { buildTaskImages, imageTemplateFrom, localTagFor } from "./tasks-prebuild.js";

// ── THE EDGE THAT READS A TASK SET (docs/architecture/standard-task-formats.md, slices 2+4) ──────────
//
// The pure package takes a PARSED task set; this is where task.yaml, task.toml and tests/ are actually read.
// What these pin is what the format costs to read wrong: a dropped `[environment]` block under-provisions a
// task and the failure reads as the agent's, and a tests/ tree flattened silently grades against files the
// case never carried.
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everdict-taskset-"));
  await mkdir(join(root, "hello", "tests"), { recursive: true });
  await writeFile(
    join(root, "hello", "task.yaml"),
    [
      "instruction: |",
      "  Write hello to /app/out.txt",
      "difficulty: easy",
      "tags:",
      "  - fs",
      "max_agent_timeout_sec: 120",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "hello", "task.toml"),
    [
      "[verifier]",
      "timeout_sec = 30",
      'env = { STRICT = "1" }',
      "",
      "[environment]",
      "cpus = 2",
      "memory_mb = 4096",
      'network_mode = "no-network"',
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "hello", "tests", "test.sh"), "#!/bin/bash\necho 1 > /logs/verifier/reward.txt\n");
  await writeFile(join(root, "hello", "Dockerfile"), "FROM alpine:3\n");
  // …and a directory that is not a task at all — a repository root has README/scripts beside its tasks.
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\n");
  return root;
}

describe("walkTaskSet — task.yaml, task.toml and tests/, or a refusal", () => {
  it("reads the instruction, the world and the verifier bytes, and ignores non-task directories", async () => {
    const entries = await walkTaskSet(await fixture());
    expect(entries).toHaveLength(1);
    const task = entries[0]?.task;
    expect(task).toMatchObject({
      id: "hello",
      instruction: "Write hello to /app/out.txt\n",
      difficulty: "easy",
      tags: ["fs"],
      timeoutSec: 120,
      verifierTimeoutSec: 30,
      verifierEnv: { STRICT: "1" },
      cpus: 2,
      memoryMb: 4096,
      networkMode: "no-network",
    });
    expect(Object.keys(task?.tests as Record<string, string>)).toEqual(["test.sh"]);
    expect(entries[0]?.hasDockerfile).toBe(true);
  });

  it("emits exactly what the ingestion edge parses — one shape, read here and validated there", async () => {
    const entries = await walkTaskSet(await fixture());
    const tasks = parseTerminalBenchTasks(
      JSON.stringify({ tasks: entries.map((e) => ({ ...e.task, image: "ghcr.io/acme/tb-hello:1" })) }),
    );
    expect(tasks[0]?.instruction).toContain("Write hello");
    expect(tasks[0]?.networkMode).toBe("no-network");
    expect(tasks[0]?.verifierEnv).toEqual({ STRICT: "1" });
  });

  it("refuses a directory that is not a task set, and a nested tests/ tree", async () => {
    const empty = await mkdtemp(join(tmpdir(), "everdict-empty-"));
    await expect(walkTaskSet(empty)).rejects.toThrow(/not a Terminal-Bench task set/);
    const root = await fixture();
    await mkdir(join(root, "hello", "tests", "data"), { recursive: true });
    await expect(walkTaskSet(root)).rejects.toThrow(/subdirectories/);
  });
});

describe("prebuild — what is built is what the template claims", () => {
  it("builds every task and refuses a set where one task has no Dockerfile", async () => {
    const entries = await walkTaskSet(await fixture());
    const calls: string[][] = [];
    const io = { log: () => {}, docker: async (args: string[]) => void calls.push(args) };
    const built = await buildTaskImages(entries, { prefix: "tb", io });
    expect(built.get("hello")).toBe(localTagFor("tb", "hello"));
    expect(calls[0]?.slice(0, 3)).toEqual(["build", "-t", "tb-hello:latest"]);
    await expect(
      buildTaskImages([{ ...(entries[0] as (typeof entries)[number]), hasDockerfile: false }], { prefix: "tb", io }),
    ).rejects.toThrow(/no Dockerfile/);
  });

  it("derives an {id} template only when it describes EVERY pushed ref", () => {
    // A task id that also appears in the ACCOUNT name — the substitution has to be the repository segment,
    // not the first characters that happen to match.
    expect(imageTemplateFrom(new Map([["a", "ghcr.io/acme/tb-a:latest"]]), "tb")).toBe("ghcr.io/acme/tb-{id}:latest");
    expect(
      imageTemplateFrom(
        new Map([
          ["a", "ghcr.io/acme/tb-a:latest"],
          ["b", "ghcr.io/acme/tb-b:latest"],
        ]),
        "tb",
      ),
    ).toBe("ghcr.io/acme/tb-{id}:latest");
    // A registry that flattened one repository makes the template a claim about images that are not there.
    expect(
      imageTemplateFrom(
        new Map([
          ["a", "ghcr.io/acme/tb-a:latest"],
          ["b", "ghcr.io/acme/other:latest"],
        ]),
        "tb",
      ),
    ).toBeUndefined();
  });
});
