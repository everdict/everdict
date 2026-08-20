import type { ComputeHandle, Driver, EvalCase, ExecResult, Grader } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

// ── THE AGENT UNDER TEST DOES NOT HOLD THE JUDGE'S KEY (arch-review 58, W1) ──────────────────────────
//
// A code judge's script needs the judge's model config and the provider key resolved for this dispatch, and
// the job-runner supplied them by wrapping the DRIVER (`withJobEnv`). The harness and the graders share one
// compute handle, so "every exec through that driver" included the harness's — and the harness is the agent
// under test: arbitrary code, permissions deliberately disabled, running with the tenant's provider
// credential in its environment for the length of the case.
//
// Nothing needed it there. The harness has its own auth (`HARNESS_AUTH_ENV_VARS`, resolved separately); the
// only consumer of the judge env was the grading half. It was a wrapper applied one layer too wide, which is
// the third exposure this wave found and the last one that a filter could close.
//
// So the env is handed to the GRADERS' view of the compute — and to any compute they provision for
// themselves, since a code judge that spins up its own container is the same consumer one hop out. The
// harness's handle is the unwrapped one.
//
// Seen RED with `runCase` wrapping the driver instead of the grading compute, observed:
//   the agent under test ran with the tenant's judge key in its environment: expected 'sk-judge' to be undefined

const JUDGE_ENV = { EVERDICT_JUDGE_MODEL: "claude-opus-5", ANTHROPIC_API_KEY: "sk-judge" };

const evalCase = (): EvalCase =>
  ({
    id: "c1",
    task: "do the thing",
    env: { kind: "prompt" },
    graders: [],
    timeoutSec: 60,
  }) as unknown as EvalCase;

// A compute that records the env of every exec, tagged with who asked.
function world() {
  const execs: Array<{ by: string; env: Record<string, string> }> = [];
  let who = "harness";
  const compute = {
    id: "c",
    async exec(_cmd: string, opts?: { env?: Record<string, string> }): Promise<ExecResult> {
      execs.push({ by: who, env: { ...(opts?.env ?? {}) } });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  } as unknown as ComputeHandle;
  return {
    execs,
    say: (w: string) => {
      who = w;
    },
    driver: {
      id: "fake",
      async provision() {
        return compute;
      },
    } as unknown as Driver,
  };
}

describe("[R58 W1 COUNTEREXAMPLE] the judge's credential reaches the graders and not the harness", () => {
  const run = async (graderEnv?: Record<string, string>) => {
    const w = world();
    // The harness execs once while it "works"; the grader execs once while it grades.
    const harness = {
      id: "fake",
      version: "1",
      // The install step is the harness's FIRST exec, and it runs in the same environment the agent will —
      // so it is watched here too rather than being a hole the assertion walks past.
      async install(compute: ComputeHandle) {
        w.say("harness");
        await compute.exec("install-the-agent");
      },
      async *run(compute: ComputeHandle) {
        w.say("harness");
        await compute.exec("agent-does-its-thing");
        yield { t: 0, kind: "message", role: "assistant", text: "done" };
      },
    } as never;
    const grader: Grader = {
      id: "code-judge",
      needsCompute: true,
      async grade(ctx: { compute?: ComputeHandle }) {
        w.say("grader");
        await ctx.compute?.exec("bash /judge.sh");
        return [{ graderId: "code-judge", metric: "judge:quality", value: 1, pass: true }];
      },
    } as unknown as Grader;

    await runCase(evalCase(), {
      driver: w.driver,
      environment: { seed: async () => {}, snapshot: async () => ({ kind: "prompt", output: "" }) } as never,
      harness,
      graders: [grader],
      runCtx: {} as never,
      ...(graderEnv ? { graderEnv } : {}),
    });
    return w.execs;
  };

  it("gives the GRADER the judge env", async () => {
    const execs = await run(JUDGE_ENV);
    const grading = execs.find((e) => e.by === "grader");
    expect(grading, "the grader never ran, so this test asserts nothing").toBeDefined();
    expect(grading?.env.ANTHROPIC_API_KEY, "a code judge cannot reach the model it was told to use").toBe("sk-judge");
    expect(grading?.env.EVERDICT_JUDGE_MODEL).toBe("claude-opus-5");
  });

  it("does NOT give it to the harness — on ANY of its execs", async () => {
    // EVERY exec, not the first one. The harness installs and then runs, and a check that looked only at the
    // first would stay green over a leak in the second — which is precisely the mutation that must not
    // survive (rule `testing`: a green that could not have failed is not evidence).
    const execs = await run(JUDGE_ENV);
    const agent = execs.filter((e) => e.by === "harness");
    expect(agent.length, "the harness never ran, so this test asserts nothing").toBeGreaterThanOrEqual(2);
    for (const e of agent) {
      expect(
        e.env.ANTHROPIC_API_KEY,
        "the agent under test ran with the tenant's judge key in its environment",
      ).toBeUndefined();
      expect(e.env.EVERDICT_JUDGE_MODEL).toBeUndefined();
    }
  });

  it("changes nothing when there is no judge env to hand over", async () => {
    const execs = await run();
    expect(execs.every((e) => Object.keys(e.env).length === 0)).toBe(true);
  });
});
