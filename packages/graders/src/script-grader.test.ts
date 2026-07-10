import { AppError, type ComputeHandle, type ExecOpts, type GradeContext } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { makeGraders } from "./make-graders.js";
import { ScriptGrader } from "./script-grader.js";

function mockCompute(stdout: string, exitCode = 0) {
  const writes: Array<{ path: string; data: string }> = [];
  const execs: Array<{ cmd: string; opts?: ExecOpts }> = [];
  const compute: ComputeHandle = {
    async exec(cmd: string, opts?: ExecOpts) {
      execs.push({ cmd, opts });
      return { exitCode, stdout, stderr: "" };
    },
    async writeFile(path: string, data: string) {
      writes.push({ path, data });
    },
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { compute, writes, execs };
}

const ctx = (compute?: ComputeHandle): GradeContext => ({
  case: { id: "c1", env: { kind: "prompt" }, task: "answer q", graders: [], timeoutSec: 60, tags: [] },
  trace: [{ t: 0, kind: "message", role: "assistant", text: "42" }],
  snapshot: { kind: "prompt", output: "42" },
  ...(compute ? { compute } : {}),
});

describe("ScriptGrader — user code over the full serialized GradeContext", () => {
  it("writes the context JSON + inline code into the compute, runs the interpreter, and collects the Score[]", async () => {
    const out =
      '[{"graderId":"x","metric":"accuracy","value":0.9,"pass":true},{"graderId":"x","metric":"style","value":0.7}]';
    const { compute, writes, execs } = mockCompute(out);
    const grader = new ScriptGrader({ language: "python", code: "print('scores')", id: "my-grader" });

    const scores = await grader.grade(ctx(compute));

    const contextWrite = writes.find((w) => w.path === "/tmp/everdict-grade-context.json");
    const parsed = JSON.parse(contextWrite?.data ?? "{}") as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["case", "snapshot", "trace"]); // full context, no compute handle
    expect(writes.some((w) => w.path === "/tmp/everdict-grader.py")).toBe(true); // inline code materialized
    expect(execs[0]?.cmd).toContain("python3 '/tmp/everdict-grader.py' '/tmp/everdict-grade-context.json'");
    // Multi-metric: both scores collected; graderId stamped with the runner's id (provenance).
    expect(scores.map((s) => s.metric)).toEqual(["accuracy", "style"]);
    expect(scores.every((s) => s.graderId === "my-grader")).toBe(true);
  });

  it("entrypoint mode runs a script already in the environment (node) without writing code", async () => {
    const { compute, writes, execs } = mockCompute('{"graderId":"g","metric":"m","value":1,"pass":true}');
    const grader = new ScriptGrader({ language: "node", entrypoint: ".grader/grade.mjs" });

    const scores = await grader.grade(ctx(compute));

    expect(execs[0]?.cmd).toContain("node '.grader/grade.mjs'");
    expect(writes.map((w) => w.path)).toEqual(["/tmp/everdict-grade-context.json"]); // context only
    expect(scores).toHaveLength(1); // a single Score object is accepted too
  });

  it("tolerates log lines before the verdict — the LAST JSON on stdout is the contract", async () => {
    const out = 'loading model...\nstep 2 done\n[{"graderId":"g","metric":"m","value":0.5}]';
    const { compute } = mockCompute(out);
    const scores = await new ScriptGrader({ language: "python", code: "c" }).grade(ctx(compute));
    expect(scores[0]?.value).toBe(0.5);
  });

  it("a non-zero exit is an explicit AppError (safeGrade turns it into a visible error score)", async () => {
    const { compute } = mockCompute("Traceback ...", 1);
    await expect(new ScriptGrader({ language: "python", code: "c" }).grade(ctx(compute))).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("non-Score-shaped output is an explicit AppError (never a silent default)", async () => {
    const { compute } = mockCompute('{"verdict":"good"}');
    await expect(new ScriptGrader({ language: "python", code: "c" }).grade(ctx(compute))).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("requires compute (outcome family) and either code or entrypoint", async () => {
    await expect(new ScriptGrader({ language: "python", code: "c" }).grade(ctx())).rejects.toThrow(/compute/);
    expect(() => new ScriptGrader({ language: "python" })).toThrow(/code|entrypoint/);
  });

  it("makeGraders spec→grader (user data path); missing language is an explicit error", () => {
    const [g] = makeGraders([{ id: "script", config: { language: "node", code: "console.log('[]')" } }]);
    expect(g?.id).toBe("script");
    expect(g?.needsCompute).toBe(true);
    expect(() => makeGraders([{ id: "script", config: { code: "x" } }])).toThrow(/language/);
  });

  it("image mode provisions a DEDICATED grader compute (observation-family), runs there, and disposes it", async () => {
    let disposed = false;
    let provisionedImage: string | undefined;
    const writes: string[] = [];
    const dedicated: ComputeHandle = {
      async exec() {
        return { exitCode: 0, stdout: '[{"graderId":"g","metric":"m","value":1,"pass":true}]', stderr: "" };
      },
      async writeFile(path: string) {
        writes.push(path);
      },
      async readFile() {
        return "";
      },
      async dispose() {
        disposed = true;
      },
    };
    const grader = new ScriptGrader({ language: "python", code: "c", image: "everdict/grader:1" });
    expect(grader.needsCompute).toBe(false); // the case sandbox is not held for image-mode grading
    const scores = await grader.grade({
      ...ctx(), // no case compute at all — image mode must not need it
      provision: async (spec) => {
        provisionedImage = spec.image;
        return dedicated;
      },
    });
    expect(provisionedImage).toBe("everdict/grader:1");
    expect(writes).toContain("/tmp/everdict-grade-context.json"); // context lands in the dedicated compute
    expect(scores[0]?.value).toBe(1);
    expect(disposed).toBe(true);
  });

  it("image mode disposes the dedicated compute even when the script fails", async () => {
    let disposed = false;
    const dedicated: ComputeHandle = {
      async exec() {
        return { exitCode: 1, stdout: "", stderr: "boom" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {
        disposed = true;
      },
    };
    const grader = new ScriptGrader({ language: "node", code: "c", image: "img" });
    await expect(grader.grade({ ...ctx(), provision: async () => dedicated })).rejects.toBeInstanceOf(AppError);
    expect(disposed).toBe(true);
  });

  it("image mode without a provisioning driver is an explicit error (control-plane/topology scoring paths)", async () => {
    const grader = new ScriptGrader({ language: "python", code: "c", image: "img" });
    await expect(grader.grade(ctx())).rejects.toThrow(/provisioning driver/);
  });

  it("makeGraders passes the image knob through", () => {
    const [g] = makeGraders([{ id: "script", config: { language: "python", code: "c", image: "everdict/grader:1" } }]);
    expect(g?.needsCompute).toBe(false);
  });
});
