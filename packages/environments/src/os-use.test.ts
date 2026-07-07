import type { ComputeHandle, ExecOpts, ExecResult } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { OsUseEnvironment } from "./os-use.js";

function mock(): { compute: ComputeHandle; calls: Array<{ cmd: string; display?: string }> } {
  const calls: Array<{ cmd: string; display?: string }> = [];
  const compute: ComputeHandle = {
    async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
      calls.push({ cmd, display: opts?.env?.DISPLAY });
      const stdout = cmd.startsWith("wmctrl")
        ? "Hermes Desktop\nxclock\n"
        : cmd.startsWith("base64")
          ? "UE5HYmFzZTY0\n" // screenshot base64 (mock)
          : "";
      return { exitCode: 0, stdout, stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { compute, calls };
}

describe("OsUseEnvironment (desktop computer-use)", () => {
  it("seed: runs setup with DISPLAY injected, snapshot: captures a screenshot + window list", async () => {
    const env = new OsUseEnvironment();
    const { compute, calls } = mock();
    await env.seed(compute, {
      kind: "os-use",
      display: ":99",
      setup: ["Xvfb :99 -screen 0 1024x768x24 &", "hermes &"],
      screenshotPath: "/tmp/shot.png",
    });
    // setup commands run with DISPLAY=:99.
    expect(calls.map((c) => c.cmd)).toEqual(["Xvfb :99 -screen 0 1024x768x24 &", "hermes &"]);
    expect(calls.every((c) => c.display === ":99")).toBe(true);

    const snap = await env.snapshot(compute);
    expect(snap.kind).toBe("os-use");
    expect(snap.screenshotRef).toBe("/tmp/shot.png"); // configured path
    expect(snap.screenshot).toBe("UE5HYmFzZTY0"); // the screenshot PNG is embedded as base64 (carried out of the result)
    expect(snap.windows).toEqual(["Hermes Desktop", "xclock"]); // wmctrl parsing
    // the screenshot capture (scrot) + base64 read commands run.
    expect(calls.some((c) => c.cmd.includes("scrot") && c.cmd.includes("/tmp/shot.png"))).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("base64") && c.cmd.includes("/tmp/shot.png"))).toBe(true);
  });

  it("rejects a non-os-use spec", async () => {
    const { compute } = mock();
    await expect(new OsUseEnvironment().seed(compute, { kind: "prompt" })).rejects.toThrow();
  });
});
