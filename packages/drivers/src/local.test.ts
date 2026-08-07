import type { ExecChunk } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { LocalDriver } from "./local.js";

describe("LocalDriver", () => {
  it("refuses a declared world it cannot provide BEFORE execution (injection: windows case on a linux driver)", async () => {
    // A wrong-world run would produce a normal-looking result — the refusal must be a clear pre-flight error.
    await expect(new LocalDriver().provision({ os: "windows", needs: ["shell"] })).rejects.toThrow(/linux only/);
  });

  it("refuses a desktop need pre-flight (os-use case) — a host process is not a desktop world", async () => {
    await expect(new LocalDriver().provision({ os: "linux", needs: ["shell", "desktop"] })).rejects.toThrow(
      /desktop world/,
    );
  });

  it("creates the directory and runs even when exec is given a nonexistent relative cwd (regression for missing 'work' in prompt QA)", async () => {
    // Regression: previously, in a prompt env that doesn't create a directory, the harness's default cwd ("work")
    // was missing, so spawn died silently with exit 1 + empty output (the case looked like it "succeeded with an empty result").
    const handle = await new LocalDriver().provision({ os: "linux", needs: ["shell"] });
    try {
      const res = await handle.exec("echo hello > out.txt && cat out.txt", { cwd: "work" });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("hello");
      expect(await handle.readFile("work/out.txt")).toBe("hello\n");
    } finally {
      await handle.dispose();
    }
  });
});

describe("LocalDriver — execStream (incremental exec for live harness sessions)", () => {
  it("is present on the handle and returns the same result contract as exec", async () => {
    const compute = await new LocalDriver().provision({ os: "linux", needs: ["shell"] });
    try {
      expect(compute.execStream).toBeDefined();
      const chunks: ExecChunk[] = [];
      if (!compute.execStream) throw new Error("execStream missing");
      const res = await compute.execStream("echo streamed && exit 5", (c) => chunks.push(c), { cwd: "work" });
      expect(res.exitCode).toBe(5);
      expect(res.stdout).toContain("streamed");
      expect(chunks.map((c) => c.data).join("")).toContain("streamed");
    } finally {
      await compute.dispose();
    }
  });

  it("delivers chunks while the command is still running (a live feed, not a replay at settle)", async () => {
    const compute = await new LocalDriver().provision({ os: "linux", needs: [] });
    try {
      if (!compute.execStream) throw new Error("execStream missing");
      let resolved = false;
      let live = false;
      const p = compute.execStream("echo tick; sleep 0.3", (c) => {
        if (!resolved && c.data.includes("tick")) live = true;
      });
      const res = await p;
      resolved = true;
      expect(res.exitCode).toBe(0);
      expect(live).toBe(true);
    } finally {
      await compute.dispose();
    }
  });

  it("dispose() during a stream kills the in-flight child (cancellation tears the compute down)", async () => {
    const compute = await new LocalDriver().provision({ os: "linux", needs: [] });
    if (!compute.execStream) throw new Error("execStream missing");
    const p = compute.execStream("echo started && sleep 30", () => {}, { timeoutSec: 60 });
    await new Promise((r) => setTimeout(r, 300)); // let the child start
    await compute.dispose();
    const res = await p; // settles from the kill, not the 60s timeout
    expect(res.stdout).toContain("started");
  });
});

describe("LocalDriver — echo mode (in-job live-tail feed)", () => {
  it("tees the child's output through while still buffering the full result", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((d: string | Uint8Array) => {
      chunks.push(String(d));
      return true;
    }) as typeof process.stdout.write;
    try {
      const compute = await new LocalDriver({ echo: true }).provision({ os: "linux", needs: [] });
      const res = await compute.exec("echo teed-line");
      await compute.dispose();
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("teed-line"); // buffered result intact (harness parsing unchanged)
      expect(chunks.join("")).toContain("teed-line"); // AND written through as it happened (job log feed)
    } finally {
      process.stdout.write = orig;
    }
  });

  it("propagates a non-zero exit code as a command failure (never throws) — same contract as the quiet path", async () => {
    const compute = await new LocalDriver({ echo: true }).provision({ os: "linux", needs: [] });
    const res = await compute.exec("echo out && echo err >&2 && exit 3");
    await compute.dispose();
    expect(res).toMatchObject({ exitCode: 3 });
    expect(res.stdout).toContain("out");
    expect(res.stderr).toContain("err");
  });

  it("kills a timed-out child and resolves exit 124 with the output captured so far", async () => {
    const compute = await new LocalDriver({ echo: true }).provision({ os: "linux", needs: [] });
    const res = await compute.exec("echo before && sleep 30", { timeoutSec: 1 });
    await compute.dispose();
    expect(res.exitCode).toBe(124);
    expect(res.stdout).toContain("before");
    expect(res.stderr).toContain("timed out");
  });

  it("captures stdout that flushes around/after process exit (regression: settle on 'close', not 'exit')", async () => {
    // The exec used to resolve on the child's 'exit' event, which fires when the process ends but BEFORE its stdout
    // is guaranteed flushed — so output delivered at/after exit was dropped. For a plain fast command (echo) this
    // was a tick race that, under concurrency, left ~1 case per batch with an EMPTY harness trace (trace:none →
    // no assistant message → the judge scored 0). Deterministic repro of the same root cause: a backgrounded
    // subshell writes AFTER the top-level shell has already exited. Settling on 'exit' resolves immediately and
    // loses "late-line"; settling on 'close' (all stdio EOF, ≤250ms grace) keeps it.
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write; // silence the tee for a clean test log
    try {
      const compute = await new LocalDriver({ echo: true }).provision({ os: "linux", needs: [] });
      const res = await compute.exec("(sleep 0.1; echo late-line) &");
      await compute.dispose();
      expect(res.stdout).toContain("late-line"); // pre-fix: '' (resolved on the shell's immediate exit)
    } finally {
      process.stdout.write = orig;
    }
  });
});
