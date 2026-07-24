import type { ComputeHandle, ExecResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type CodeToolRuntime, type ResolvedCodeTool, buildCodeTool, buildCodeTools } from "./code-tools.js";

function fakeHandle(exec: (cmd: string, opts?: { env?: Record<string, string> }) => Promise<ExecResult>) {
  const files = new Map<string, string>();
  let disposed = false;
  const handle: ComputeHandle = {
    exec: async (cmd, opts) => exec(cmd, opts),
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    readFile: async (path) => files.get(path) ?? "",
    dispose: async () => {
      disposed = true;
    },
  };
  return { handle, files, disposed: () => disposed };
}

const tool = (over: Partial<ResolvedCodeTool> = {}): ResolvedCodeTool => ({
  name: "scorer",
  description: "score a thing",
  language: "python",
  code: "src",
  parametersSchema: {},
  isReadOnly: true,
  env: {},
  sandbox: false,
  ...over,
});

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

describe("buildCodeTool", () => {
  it("provisions, writes the input + script, runs the interpreter, and returns the stdout result", async () => {
    let ranCmd = "";
    const f = fakeHandle(async (cmd) => {
      ranCmd = cmd;
      return ok('log line\n{"content":"the answer","isError":false}');
    });
    const rt: CodeToolRuntime = { provision: async () => f.handle, isolated: false };
    const def = buildCodeTool(tool({ code: "print(...)" }), rt);
    expect(def.name).toBe("code__scorer");
    expect(def.isReadOnly).toBe(true);
    const res = await def.call({ x: 1 }, {});
    expect(res).toEqual({ content: "the answer", isError: false });
    expect(ranCmd).toContain("python3");
    expect(f.files.get("/tmp/everdict-tool-input.json")).toBe(JSON.stringify({ x: 1 }));
    expect(f.files.get("/tmp/everdict-tool.py")).toBe("print(...)");
    expect(f.disposed()).toBe(true);
  });

  it("marks a non-zero exit as an error result", async () => {
    const f = fakeHandle(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
    const def = buildCodeTool(tool(), { provision: async () => f.handle, isolated: false });
    const res = await def.call({}, {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("boom");
    expect(f.disposed()).toBe(true);
  });

  it("passes the bound env and passes a plain-JSON result through as content", async () => {
    let gotEnv: Record<string, string> | undefined;
    const f = fakeHandle(async (_cmd, opts) => {
      gotEnv = opts?.env;
      return ok('{"answer":42}');
    });
    const def = buildCodeTool(tool({ env: { API_KEY: "sk-1" }, language: "node" }), {
      provision: async () => f.handle,
      isolated: false,
    });
    const res = await def.call({}, {});
    expect(gotEnv).toEqual({ API_KEY: "sk-1" });
    expect(res).toEqual({ content: '{"answer":42}', isError: false });
    expect(f.files.has("/tmp/everdict-tool.mjs")).toBe(true); // node → .mjs
  });

  it("returns an error result (never throws) when provisioning fails", async () => {
    const def = buildCodeTool(tool(), {
      provision: async () => {
        throw new Error("no compute");
      },
      isolated: false,
    });
    const res = await def.call({}, {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no compute");
  });
});

describe("buildCodeTools sandbox gate", () => {
  const host: CodeToolRuntime = {
    provision: async () => {
      throw new Error("unused");
    },
    isolated: false,
  };
  const isolated: CodeToolRuntime = {
    provision: async () => {
      throw new Error("unused");
    },
    isolated: true,
  };

  it("runs own-workspace code on a host runtime but skips adopted-from-others code without isolation", () => {
    const r = buildCodeTools([tool({ name: "own", sandbox: false }), tool({ name: "adopted", sandbox: true })], host);
    expect(r.defs.map((d) => d.name)).toEqual(["code__own"]);
    expect(r.skipped).toEqual(["adopted"]);
  });

  it("runs adopted-from-others code when the runtime is isolated", () => {
    const r = buildCodeTools([tool({ name: "adopted", sandbox: true })], isolated);
    expect(r.defs.map((d) => d.name)).toEqual(["code__adopted"]);
    expect(r.skipped).toEqual([]);
  });

  it("skips every code tool when no runtime is available", () => {
    const r = buildCodeTools([tool({ sandbox: false })], undefined);
    expect(r.defs).toEqual([]);
    expect(r.skipped).toEqual(["scorer"]);
  });
});
