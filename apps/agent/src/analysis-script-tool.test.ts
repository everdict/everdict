import type { ComputeHandle, ExecResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildRunAnalysisTool } from "./analysis-script-tool.js";
import type { CodeToolRuntime } from "./code-tools.js";

function fakeHandle(exec: (cmd: string) => Promise<ExecResult>) {
  const files = new Map<string, string>();
  let disposed = false;
  const handle: ComputeHandle = {
    exec: async (cmd: string) => exec(cmd),
    writeFile: async (path: string, data: string | Buffer) => {
      files.set(path, typeof data === "string" ? data : data.toString("utf8"));
    },
    dispose: async () => {
      disposed = true;
    },
  } as unknown as ComputeHandle;
  return { handle, files, disposed: () => disposed };
}

describe("run_analysis", () => {
  it("refuses a non-isolated runtime entirely — model-authored code never runs on the host", () => {
    const rt: CodeToolRuntime = { provision: async () => ({}) as ComputeHandle, isolated: false };
    expect(buildRunAnalysisTool(rt)).toBeUndefined();
  });

  it("runs the model's script through the code-tool contract (input file + interpreter + stdout) and disposes", async () => {
    const f = fakeHandle(async () => ({ exitCode: 0, stdout: '{"content":"mean=0.42"}', stderr: "" }));
    const rt: CodeToolRuntime = { provision: async () => f.handle, isolated: true };
    const tool = buildRunAnalysisTool(rt);
    if (!tool) throw new Error("tool missing");
    expect(tool.isReadOnly).toBe(false); // every call is HITL-gated

    const result = await tool.call(
      { language: "node", code: "console.log(JSON.stringify({content:'mean=0.42'}))", input: { rows: [1, 2] } },
      {},
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("mean=0.42");
    expect(f.files.get("/tmp/everdict-tool-input.json")).toBe(JSON.stringify({ rows: [1, 2] }));
    expect(f.disposed()).toBe(true); // handle released in a finally
  });
});
