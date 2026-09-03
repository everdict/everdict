import type { ComputeHandle, Driver, EvalCase, ExecResult, GradeContext, Grader } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

// ── [COUNTEREXAMPLE] A WORLD'S OWN ACCOUNT REACHES THE GRADERS, OR SAYS IT DID NOT ───────────────────
//
// docs/architecture/world-and-engagement-model.md, axis 1: observation is the PROVIDER's obligation, because
// only what stands between the actor and the world can say what passed between them. An api client's
// exchanges were declarable and unproduced for exactly this reason — nothing recorded them.
//
// Two things this pins, and the second is why the first is worth having:
//   ① the recording is fetched BEFORE grading and lands on the platform's observation channel, so a judge
//      weighs the agent's story against the world's rather than against nothing;
//   ② a recording that was PROMISED and could not be read makes the observation `sampling_failed` — never
//      `sampled` with nothing in it, which reads downstream as "we watched and the world was quiet".
const worldCase = (over: Record<string, unknown> = {}): EvalCase =>
  ({
    id: "c1",
    task: "place an order",
    env: { kind: "prompt" },
    graders: [],
    timeoutSec: 60,
    world: {
      wiring: { target_base_url: "http://shop", recording_url: "http://proxy/recording" },
      observe: { from: "recording_url" },
    },
    ...over,
  }) as unknown as EvalCase;

function world() {
  const compute = {
    id: "c",
    async exec(): Promise<ExecResult> {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  } as unknown as ComputeHandle;
  return {
    driver: {
      id: "fake",
      async provision() {
        return compute;
      },
    } as unknown as Driver,
  };
}

const harness = {
  id: "cli",
  version: "1",
  async install() {},
  async *run() {
    yield { t: 1, kind: "message", role: "assistant", text: "ordered" };
  },
} as never;

// A grader that captures what the platform's observation channel actually said — the only way to see that the
// recording reached the judgment rather than the result.
function observingGrader(): { grader: Grader; seen: Array<GradeContext["observations"]> } {
  const seen: Array<GradeContext["observations"]> = [];
  return {
    seen,
    grader: {
      id: "watcher",
      async grade(ctx: GradeContext) {
        seen.push(ctx.observations);
        return { graderId: "watcher", metric: "watched", value: 1, pass: true };
      },
    } as unknown as Grader,
  };
}

const deps = (over: Record<string, unknown> = {}) => ({
  driver: world().driver,
  environment: { seed: async () => {}, snapshot: async () => ({ kind: "prompt", output: "" }) } as never,
  harness,
  graders: [],
  runCtx: {} as never,
  ...over,
});

describe("[COUNTEREXAMPLE] a provided world's recording is observed, or its absence is stated", () => {
  it("① fetches the recording the world names and hands it to the graders as the PLATFORM's observation", async () => {
    const { grader, seen } = observingGrader();
    const asked: string[] = [];
    await runCase(
      worldCase(),
      deps({
        graders: [grader],
        fetchWorldRecording: async (url: string) => {
          asked.push(url);
          return "POST /orders 201";
        },
      }),
    );
    expect(asked, "the wiring key names WHICH coordinate holds the recording").toEqual(["http://proxy/recording"]);
    expect(seen[0]).toEqual({
      kind: "sampled",
      deltas: [{ t: expect.any(Number), kind: "world-recording", text: "POST /orders 201" }],
    });
  });

  it("② a promised recording that could not be read is sampling_failed, never an empty account", async () => {
    const { grader, seen } = observingGrader();
    await runCase(
      worldCase(),
      deps({
        graders: [grader],
        fetchWorldRecording: async () => {
          throw new Error("the proxy is gone");
        },
      }),
    );
    expect(seen[0]).toEqual({ kind: "unobserved", reason: "sampling_failed" });
  });

  it("…and so is a world that declares a recording at an execution site that cannot fetch one", async () => {
    const { grader, seen } = observingGrader();
    await runCase(worldCase(), deps({ graders: [grader] }));
    expect(seen[0]).toEqual({ kind: "unobserved", reason: "sampling_failed" });
  });

  it("a case that promises no recording is untouched — absence of a promise is not a failure", async () => {
    const { grader, seen } = observingGrader();
    await runCase(worldCase({ world: { wiring: { target_base_url: "http://shop" } } }), deps({ graders: [grader] }));
    expect(seen[0]).toEqual({ kind: "unobserved", reason: "unsupported" });
  });
});
