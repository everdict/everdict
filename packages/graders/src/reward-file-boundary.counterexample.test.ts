import type { CaseJob, ComputeHandle, EvalCase, ExecResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { RewardFileGrader } from "./reward-file.js";

// ── THE EVALUATED AGENT MAY NOT SEE, OR WRITE, ITS OWN VERDICT (arch-review 56, Wave B) ──────────────
//
// The Terminal-Bench verifier reads a PUBLISHED REWARD FILE instead of an exit code, which is right: a Terminal-Bench task's
// `test.sh` routinely exits 0 having written `reward 0`. What the reward protocol assumes, and this
// implementation does not provide, is that the reward was written by the VERIFIER.
//
// Three boundaries are open, and they compose into one sentence: the thing being measured can read the
// measurement and can author its own result.
//
//   1. DISCLOSURE. The Terminal-Bench mapper puts the whole `tests/` directory and the verifier's env into
//      `EvalCase.graders[].config`. `CaseJob.evalCase` is the entire EvalCase, and the K8s/Nomad backends
//      base64 the entire CaseJob into `EVERDICT_CASE_JOB` on the job container — which is the container the
//      harness runs in, and `LocalDriver` spawns the harness with `env: { ...process.env }`. So the agent
//      under evaluation can read the hidden tests and the verifier's credentials out of its own environment.
//      "Tests are copied after the agent finishes" is true of the FILESYSTEM and says nothing about
//      disclosure — the bytes were handed over before the first token.
//
//   2. AUTHORSHIP. The verifier runs on the same `ctx.compute` the agent used, and the reward directory is
//      `mkdir -p`'d rather than emptied. An agent that writes `/logs/verifier/reward.json` before it exits
//      has authored the value this grader reads — and JSON wins over the `.txt` the real verifier writes.
//      A verifier that crashes or times out leaves the agent's file standing.
//
//   3. TRAVERSAL. `tests` is a bare `Record<string, string>` written as `${testsDir}/${name}` with no
//      normalization, and `LocalDriver.writeFile` is `join(root, path)` with no containment check. A task
//      whose key is `../../x` writes outside the sandbox.
//
// These are pinned here, at the grader, because that is where the reward is turned into a constitutional
// verdict. The disclosure arm is pinned separately in `@everdict/contracts` (the job payload must not carry
// verifier-private material at all) — a grader cannot un-send bytes the dispatcher already shipped.

function fakeCompute(files: Map<string, string>, onExec?: (cmd: string) => void): ComputeHandle {
  return {
    id: "c1",
    // A shell that actually models the two commands this grader's protocol depends on. The first draft
    // answered every `exec` with exit 0 and empty stdout, so `cat reward.json` looked like an EMPTY reward and
    // the preseed arm passed having exercised nothing — the vacuous-fixture rule, caught by running it.
    async exec(cmd: string): Promise<ExecResult> {
      onExec?.(cmd);
      const cat = /^cat '?([^']+)'?$/.exec(cmd.trim());
      if (cat) {
        const held = files.get(cat[1] as string);
        return held === undefined
          ? { exitCode: 1, stdout: "", stderr: "No such file" }
          : { exitCode: 0, stdout: held, stderr: "" };
      }
      // `rm -rf <dir>` — what a verifier boundary has to do before it measures anything.
      const rm = /\brm\s+-rf?\s+'?([^'\s]+)'?/.exec(cmd);
      if (rm) {
        const prefix = rm[1] as string;
        for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile(path: string, data: string) {
      files.set(path, data);
    },
    async readFile(path: string) {
      const held = files.get(path);
      if (held === undefined) throw new Error(`no such file: ${path}`);
      return held;
    },
    async snapshot() {
      return { kind: "prompt", output: "" } as never;
    },
    async release() {
      /* nothing to release */
    },
  } as unknown as ComputeHandle;
}

// The grader takes its CONFIG directly (not a GraderSpec) — the first draft wrapped it in `{ id, config }`,
// so `this.cfg.files` was undefined and the traversal arm exercised nothing. Fixtures are derived from the
// production constructor, and this is what that rule is for.
const grader = (cfg: Record<string, unknown>) => new RewardFileGrader(cfg as never);

// RED as of 0f4da459, observed:
//   the agent's own reward file decided the case: expected [ { …, value: 1, pass: true } ] … to be false
describe("[R56 WAVE-B COUNTEREXAMPLE #2 — CLOSED] the verifier's reward is the verifier's", () => {
  it("does not read a reward the agent left behind before the verifier ran", async () => {
    // Given an agent that wrote a winning reward into the verifier's directory during its own turn…
    const files = new Map<string, string>([["/logs/verifier/reward.json", JSON.stringify({ reward: 1 })]]);
    // …and a verifier that runs and publishes NOTHING (it crashed, or it was the agent's file all along).
    const compute = fakeCompute(files);

    const scores = await grader({ cmd: "bash /tests/test.sh" }).grade({
      compute,
      result: { caseId: "c1" },
    } as never);

    const primary = scores.find((s) => s.metric === "tests_pass");
    // `Score` is a discriminated union and only a MEASURED one has `pass` — reading it off the union is the
    // shape rule `graders` exists to prevent, and here it would also be the wrong question.
    expect(
      primary !== undefined && "pass" in primary ? primary.pass : undefined,
      "the agent's own reward file decided the case — the evaluated thing authored its verdict",
    ).not.toBe(true);
    // …and it is UNMEASURED rather than a zero: nobody published a reward, which is not the same fact as a
    // verifier that ran and scored the work at zero.
    expect(primary?.status).toBe("unmeasured");
  });

  it("clears the reward namespace before the verifier runs, rather than only creating it", async () => {
    // The mechanism, pinned so the fix cannot be "read harder": the directory the verdict comes out of is
    // emptied, so nothing an agent wrote can survive into the measurement.
    const cleared: string[] = [];
    const files = new Map<string, string>([["/logs/verifier/reward.txt", "1"]]);
    const compute = fakeCompute(files, (cmd) => cleared.push(cmd));

    await grader({ cmd: "true" }).grade({ compute, result: { caseId: "c1" } } as never);

    expect(
      cleared.some((c) => /\brm\b/.test(c) && c.includes("/logs/verifier")),
      "the reward directory was created but never emptied, so an agent-authored file survives into the verdict",
    ).toBe(true);
  });

  it("refuses a tests path that climbs out of the tests directory", async () => {
    // A Terminal-Bench task is third-party content. `../../` in a key is a write outside the sandbox — on the
    // self-hosted and CLI lanes that is the operator's own filesystem.
    const files = new Map<string, string>();
    const compute = fakeCompute(files);

    await expect(
      grader({ cmd: "true", files: { "../../escape.sh": "#!/bin/sh\n" } }).grade({
        compute,
        result: { caseId: "c1" },
      } as never),
      "a task file escaped the tests directory",
    ).rejects.toThrow(/path|escape|outside|traversal/i);
    expect([...files.keys()].some((k) => k.includes(".."))).toBe(false);
  });
});

// ── AND THE BYTES NEVER REACH THE AGENT AT ALL ──────────────────────────────────────────────────────
//
// The grader-side fixes above are necessary and not sufficient: the disclosure happens in the DISPATCHER,
// before any grader runs. Stripping the graders from the payload is not available either — the job-runner
// reconstructs them from that same object INSIDE the container, which is what lets an outcome grader touch
// `ctx.compute`. Agent and verifier share one environment by design.
//
// So the lane REFUSES the case instead of measuring it dishonestly. That is the whole finding in one
// assertion: a benchmark whose hidden tests ride the agent's own environment is not producing scores.
describe("[R56 WAVE-B COUNTEREXAMPLE #3 — CLOSED] a shared-environment lane refuses a case it would disclose", () => {
  it("refuses to serialize a job whose grading depends on material the agent must not see", async () => {
    const { caseJobPayload } = await import("@everdict/contracts");
    const job = {
      runId: "r1",
      tenant: "acme",
      evalCase: {
        id: "c1",
        task: "do the thing",
        env: { kind: "repo", source: { path: "/app" } },
        graders: [
          {
            id: "reward-file",
            config: {
              cmd: "bash /tests/test.sh",
              files: { "test.sh": "assert_solution()" },
              env: { OPENAI_API_KEY: "sk-real" },
            },
          },
        ],
      } as unknown as EvalCase,
    } as unknown as CaseJob;

    expect(
      () => caseJobPayload(job),
      "the hidden tests and the verifier's credential were shipped in the agent's own environment",
    ).toThrow(/must not see/);
    // …and the refusal NAMES what would have leaked, so an operator can act on it rather than work around it.
    try {
      caseJobPayload(job);
    } catch (err) {
      expect(String(err)).toContain("reward-file.files");
      expect(String(err)).toContain("reward-file.env");
    }
  });

  it("still ships an ordinary case — the refusal must not be a refusal of everything", async () => {
    const { caseJobPayload } = await import("@everdict/contracts");
    const job = {
      runId: "r1",
      tenant: "acme",
      evalCase: {
        id: "c1",
        task: "do the thing",
        env: { kind: "repo", source: { path: "/app" } },
        graders: [{ id: "tests-pass", config: { cmd: "pytest" } }],
      } as unknown as EvalCase,
    } as unknown as CaseJob;
    const payload = caseJobPayload(job);
    expect(Buffer.from(payload, "base64").toString()).toContain("do the thing");
  });
});
