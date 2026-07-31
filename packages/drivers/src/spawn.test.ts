import type { ExecChunk } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { chunkSinks, runSpawn } from "./spawn.js";

describe("runSpawn (the shared incremental spawn core)", () => {
  it("delivers chunks incrementally, in order, while still resolving the full buffered result", async () => {
    const chunks: ExecChunk[] = [];
    const res = await runSpawn("echo one; echo two >&2; echo three", {
      timeoutMs: 5_000,
      sinks: chunkSinks((c) => chunks.push(c)),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("one");
    expect(res.stdout).toContain("three");
    expect(res.stderr).toContain("two");
    expect(
      chunks
        .filter((c) => c.stream === "stdout")
        .map((c) => c.data)
        .join(""),
    ).toContain("one");
    expect(
      chunks
        .filter((c) => c.stream === "stderr")
        .map((c) => c.data)
        .join(""),
    ).toContain("two");
  });

  it("a chunk arrives BEFORE the exec resolves (the incremental contract, not a post-hoc replay)", async () => {
    let sawChunkBeforeResolve = false;
    let resolved = false;
    const p = runSpawn("echo early; sleep 0.3", {
      timeoutMs: 5_000,
      sinks: chunkSinks(() => {
        if (!resolved) sawChunkBeforeResolve = true;
      }),
    });
    const res = await p;
    resolved = true;
    expect(res.exitCode).toBe(0);
    expect(sawChunkBeforeResolve).toBe(true);
  });

  it("a non-zero exit resolves as a result (never throws) — exec's contract", async () => {
    const res = await runSpawn("echo out && exit 7", { timeoutMs: 5_000 });
    expect(res.exitCode).toBe(7);
    expect(res.stdout).toContain("out");
  });

  it("kills a timed-out detached group and resolves 124 with the caller's note and captured output", async () => {
    const res = await runSpawn("echo before && sleep 30", {
      detached: true,
      timeoutMs: 500,
      timeoutNote: "[everdict] test timed out",
    });
    expect(res.exitCode).toBe(124);
    expect(res.stdout).toContain("before");
    expect(res.stderr).toContain("test timed out");
  });

  it("argv mode runs the binary directly and streams its output", async () => {
    const chunks: ExecChunk[] = [];
    const res = await runSpawn("sh", {
      args: ["-c", "printf argv-mode"],
      timeoutMs: 5_000,
      sinks: chunkSinks((c) => chunks.push(c)),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("argv-mode");
    expect(chunks.map((c) => c.data).join("")).toContain("argv-mode");
  });

  it("a spawn failure (missing binary) resolves 127 instead of throwing", async () => {
    const res = await runSpawn("definitely-not-a-real-binary-xyz", {
      args: ["--version"],
      timeoutMs: 2_000,
    });
    expect(res.exitCode).toBe(127);
  });

  it("captures output that flushes around/after exit (settle on 'close' with the 250ms exit grace)", async () => {
    const res = await runSpawn("(sleep 0.1; echo late-line) &", { detached: true, timeoutMs: 5_000 });
    expect(res.stdout).toContain("late-line");
  });
});
