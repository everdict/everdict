import { describe, expect, it } from "vitest";
import { LocalDriver } from "./local.js";

describe("LocalDriver", () => {
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
});
