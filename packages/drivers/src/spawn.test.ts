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
    // Certified as an ORDER, not as a timing margin: both events append to one sequence — the first chunk
    // when the sink fires, the settle in a `then` attached at creation — so the assertion reads which
    // happened first instead of sampling a flag at a moment the scheduler picks. The tail sleep keeps the
    // two a second apart, so a loaded machine cannot make them adjacent: pre-fix (a post-hoc replay of the
    // buffers) the sequence is ["resolve"] and this still fails.
    const order: string[] = [];
    let chunkAt = 0;
    let settledAt = 0;
    const p = runSpawn("echo early; sleep 1", {
      timeoutMs: 30_000,
      sinks: chunkSinks(() => {
        if (order.length === 0) {
          order.push("chunk");
          chunkAt = Date.now();
        }
      }),
    }).then((r) => {
      order.push("resolve");
      settledAt = Date.now();
      return r;
    });
    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(order).toEqual(["chunk", "resolve"]);
    // And the two are a second apart, not adjacent: a replay dispatched at settle can win an ordering check
    // through a microtask, never a wall-clock gap. A stall only ever delays the settle and widens it.
    expect(settledAt - chunkAt).toBeGreaterThan(300);
  }, 30_000);

  it("a non-zero exit resolves as a result (never throws) — exec's contract", async () => {
    const res = await runSpawn("echo out && exit 7", { timeoutMs: 5_000 });
    expect(res.exitCode).toBe(7);
    expect(res.stdout).toContain("out");
  });

  it("kills a timed-out detached group and resolves 124 with the caller's note and captured output", async () => {
    // The budget is incidental — what is certified is the OUTCOME of the kill (124, the output captured
    // before it, the caller's note). It is deliberately wider than the shell needs to start and flush
    // `before`, because a fork on a loaded machine (a repo-wide parallel test run) can cost hundreds of
    // milliseconds and a budget that expires first would fail on scheduling rather than on the contract.
    // `sleep 30` still outlives it by an order of magnitude, so the timeout path is the one taken.
    const res = await runSpawn("echo before && sleep 30", {
      detached: true,
      timeoutMs: 3_000,
      timeoutNote: "[everdict] test timed out",
    });
    expect(res.exitCode).toBe(124);
    expect(res.stdout).toContain("before");
    expect(res.stderr).toContain("test timed out");
  }, 30_000);

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
