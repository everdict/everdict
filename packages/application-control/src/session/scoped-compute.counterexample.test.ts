import type { ComputeHandle, ExecChunk, ExecOpts, ExecResult, ImageProvenance } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { scopedComputeHandle } from "./scoped-compute.js";

// ── A TASK SCOPE REBASES PATHS; IT DOES NOT OWN THE CONTAINER, AND IT IS NOT A SANDBOX ───────────────
//
// `scopedComputeHandle` is what makes consecutive eval cases independent inside ONE warm session container.
// It had no test at all, and three of its properties are load-bearing in ways that fail quietly:
//
//   · `dispose()` MUST be a no-op. A scope that tore down the container would end the session on the first
//     case's `finally` — and rule `contracts` requires every ComputeHandle to be released in one, so that
//     teardown is guaranteed to be reached.
//   · `execStream` must stay ABSENT when the inner handle has none. The contract says callers DETECT support
//     by presence and pick an incremental parse path; a wrapper that always defines it makes every harness
//     take the streaming path against a handle that cannot stream.
//   · `image` is forwarded, not re-stated. A scope answering `{kind:"none"}` would make a scoped task look
//     like it ran no image at all, losing the digest the driver read.

interface Call {
  cmd: string;
  cwd?: string;
}

class InnerHandle implements ComputeHandle {
  readonly calls: Call[] = [];
  readonly writes: [string, string][] = [];
  readonly reads: string[] = [];
  disposed = 0;
  readonly image: ImageProvenance = {
    kind: "resolved",
    images: [{ ref: "img:1", digest: "sha256:abc" }],
    by: "driver",
  };
  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    this.calls.push({ cmd, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.writes.push([path, data]);
  }
  async readFile(path: string): Promise<string> {
    this.reads.push(path);
    return "";
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

class StreamingInner extends InnerHandle {
  async execStream(cmd: string, onChunk: (c: ExecChunk) => void, opts?: ExecOpts): Promise<ExecResult> {
    this.calls.push({ cmd, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
    onChunk({ stream: "stdout", data: "chunk" });
    return { exitCode: 0, stdout: "chunk", stderr: "" };
  }
}

const execCalls = (inner: InnerHandle): Call[] => inner.calls.filter((c) => !c.cmd.startsWith("mkdir -p"));
const mkdirs = (inner: InnerHandle): string[] =>
  inner.calls.filter((c) => c.cmd.startsWith("mkdir -p")).map((c) => c.cmd);

describe("a per-task compute scope", () => {
  it("runs a relative cwd under the task prefix, and defaults to the prefix itself", async () => {
    const inner = new InnerHandle();
    const scoped = scopedComputeHandle(inner, "tasks/3");
    await scoped.exec("pytest", { cwd: "repo" });
    await scoped.exec("ls");
    expect(execCalls(inner)).toEqual([
      { cmd: "pytest", cwd: "tasks/3/repo" },
      { cmd: "ls", cwd: "tasks/3" },
    ]);
  });

  it("carries the caller's other exec options through unchanged", async () => {
    const inner = new InnerHandle();
    let seen: ExecOpts | undefined;
    inner.exec = async (_cmd, opts) => {
      seen = opts;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await scopedComputeHandle(inner, "tasks/1").exec("go test", {
      cwd: "svc",
      timeoutSec: 30,
      env: { CI: "1" },
    });
    expect(seen).toEqual({ cwd: "tasks/1/svc", timeoutSec: 30, env: { CI: "1" } });
  });

  it("creates each distinct rebased directory once, before its first exec there", async () => {
    const inner = new InnerHandle();
    const scoped = scopedComputeHandle(inner, "tasks/2");
    await scoped.exec("a", { cwd: "x" });
    await scoped.exec("b", { cwd: "x" });
    await scoped.exec("c", { cwd: "y" });
    expect(mkdirs(inner)).toEqual(["mkdir -p 'tasks/2/x'", "mkdir -p 'tasks/2/y'"]);
    // Ordering is the point, not just the count: `docker exec -w` requires the directory to exist already.
    expect(inner.calls[0]).toEqual({ cmd: "mkdir -p 'tasks/2/x'" });
    expect(inner.calls[1]).toEqual({ cmd: "a", cwd: "tasks/2/x" });
  });

  it("rebases file paths too", async () => {
    const inner = new InnerHandle();
    const scoped = scopedComputeHandle(inner, "tasks/4");
    await scoped.writeFile("out.txt", "hi");
    await scoped.readFile("out.txt");
    expect(inner.writes).toEqual([["tasks/4/out.txt", "hi"]]);
    expect(inner.reads).toEqual(["tasks/4/out.txt"]);
  });

  // The session owns the container. A scope that forwarded dispose would tear it down on the first case's
  // `finally`, and every ComputeHandle is released in one.
  it("never disposes the session's container", async () => {
    const inner = new InnerHandle();
    await scopedComputeHandle(inner, "tasks/5").dispose();
    expect(inner.disposed).toBe(0);
  });

  // Presence IS the protocol: absent means buffered-only, and a caller reads that off the object.
  it("keeps streaming support detectable in both directions", async () => {
    expect(scopedComputeHandle(new InnerHandle(), "tasks/6").execStream).toBeUndefined();
    const streaming = new StreamingInner();
    const scoped = scopedComputeHandle(streaming, "tasks/7");
    expect(scoped.execStream).toBeTypeOf("function");
    const chunks: ExecChunk[] = [];
    await scoped.execStream?.("pytest", (c) => chunks.push(c), { cwd: "repo" });
    // The streaming path rebases and pre-creates the directory exactly as the buffered one does — a lane
    // that only fixed `exec` would put the incremental run in the session root.
    expect(mkdirs(streaming)).toEqual(["mkdir -p 'tasks/7/repo'"]);
    expect(execCalls(streaming)).toEqual([{ cmd: "pytest", cwd: "tasks/7/repo" }]);
    expect(chunks).toEqual([{ stream: "stdout", data: "chunk" }]);
  });

  it("reports the session container's own image rather than restating one", () => {
    const inner = new InnerHandle();
    expect(scopedComputeHandle(inner, "tasks/8").image).toEqual(inner.image);
  });

  // ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────
  //
  // Absolute paths pass through by design (the module says so), and a relative path may still contain "..".
  // Both are consistent: this runs INSIDE one container that the harness already controls, so the scope buys
  // case independence, not containment. Pinned so a later caller cannot mistake it for a sandbox and rely on
  // it to hold an adversary — the guard for that is the Backend's isolation, not this.
  it("does not contain an absolute path or a traversal, and does not pretend to", async () => {
    const inner = new InnerHandle();
    const scoped = scopedComputeHandle(inner, "tasks/9");
    await scoped.exec("cat secrets", { cwd: "/etc" });
    await scoped.writeFile("../8/planted.txt", "x");
    expect(execCalls(inner)).toEqual([{ cmd: "cat secrets", cwd: "/etc" }]);
    // …and an absolute cwd is not mkdir'd either: the spec owns that path.
    expect(mkdirs(inner)).toEqual([]);
    expect(inner.writes).toEqual([["tasks/9/../8/planted.txt", "x"]]);
  });
});
