import { type AgentJob, InternalError } from "@everdict/contracts";
import { DockerDriver, LocalDriver } from "@everdict/drivers";
import { describe, expect, it } from "vitest";
import { failureResult, resolveMeterUsage, runAgentJob } from "./run.js";

describe("runAgentJob", () => {
  it("runs a scripted job, produces a CaseResult, and tests-pass passes", async () => {
    const job: AgentJob = {
      harness: { id: "scripted", version: "0.0.0" },
      evalCase: {
        id: "agent-1",
        env: { kind: "repo", source: { files: { "seed.txt": "x\n" } } },
        task: "create out.txt",
        graders: [{ id: "steps" }, { id: "tests-pass", config: { cmd: "test -f out.txt" } }],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await runAgentJob(job);
    if (result.snapshot.kind !== "repo") throw new Error("expected a repo snapshot");

    expect(result.harness).toBe("scripted@0.0.0");
    const pass = result.scores.find((s) => s.graderId === "tests-pass");
    expect(pass?.pass).toBe(true);
    expect(result.snapshot.changedFiles).toContain("out.txt");
  });
});

// Metering fail-safe: the usage-proxy binds 127.0.0.1 on the runner host, so a containerized (case.image) child
// could never reach it — with metering left on, the child's model base URL is rewritten to a dead endpoint and
// every model call dies. Containerization happens two ways: the `containerize` flag (self-hosted runner) OR an
// explicitly injected container driver (DockerBackend). resolveMeterUsage must catch BOTH.
describe("resolveMeterUsage (metering ⇄ container fail-safe)", () => {
  it("meters a host-native run (default LocalDriver, no container)", () => {
    expect(resolveMeterUsage(true, {})).toBe(true);
  });

  it("does not meter when the containerize flag is set (self-hosted runner image-case)", () => {
    expect(resolveMeterUsage(true, { containerize: true })).toBe(false);
  });

  it("does not meter when an explicit DockerDriver runs the case (DockerBackend) even without the flag", () => {
    // Regression: keying only off `containerize` left this path metered, so the child's model base URL was
    // rewritten to a loopback proxy unreachable from the container, killing every model call.
    expect(resolveMeterUsage(true, { driver: new DockerDriver() })).toBe(false);
  });

  it("meters when an explicit LocalDriver runs the case host-side", () => {
    expect(resolveMeterUsage(true, { driver: new LocalDriver() })).toBe(true);
  });

  it("never meters when metering was not requested", () => {
    expect(resolveMeterUsage(false, { driver: new LocalDriver() })).toBe(false);
  });
});

// A failure inside the job — including one before the job is even decoded — must cross the process boundary as a
// CLASSIFIED CaseResult behind the sentinel, not as a bare crash (which reads backend-side as "sentinel not found").
describe("failureResult (classified result crosses the process boundary)", () => {
  it("attributes a pre-decode failure to the dispatch stage with an unknown identity", () => {
    const result = failureResult(new SyntaxError("Unexpected token in JSON"));
    expect(result.caseId).toBe("unknown");
    expect(result.harness).toBe("unknown@unknown");
    expect(result.failure?.stage).toBe("dispatch");
    expect(result.scores[0]?.pass).toBe(false);
  });

  it("preserves the harness identity and the error's stage when the job is known", () => {
    const job = { evalCase: { id: "c1" }, harness: { id: "scripted", version: "0.0.0" } };
    const result = failureResult(new InternalError("HARNESS_RUN_FAILED", {}, "exit 127"), job);
    expect(result.caseId).toBe("c1");
    expect(result.harness).toBe("scripted@0.0.0");
    expect(result.failure).toMatchObject({ stage: "run", class: "harness", retryable: false });
  });
});

// The code-judge wrapper contract on the agent path: job.judge (model config) + job.judgeAuth (dispatch-resolved
// credential) must reach a script grader's exec env — on managed allocs the backend injects them at the alloc level,
// so the agent must do the equivalent itself (withJobEnv) for the runner/local/docker paths.
describe("runAgentJob judge env threading (code-judge wrapper on the local/runner path)", () => {
  it("a script grader's exec sees EVERDICT_JUDGE_MODEL + the provider key/base-url from job.judge/judgeAuth", async () => {
    // Regression: these values never reached compute.exec — a code judge on a self-hosted runner called the
    // provider with no key (401) even when the control plane had resolved one onto the job. The case mirrors
    // buildCodeJudgeJob's wrapper shape: script + context as env files, entrypoint + contextPath grader config.
    const code = [
      "const detail = [process.env.EVERDICT_JUDGE_MODEL, process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL].join(' ')",
      "console.log(JSON.stringify({ graderId: 'judge', metric: 'judge', value: 1, pass: true, detail }))",
    ].join("\n");
    const job: AgentJob = {
      harness: { id: "scripted", version: "0.0.0" },
      evalCase: {
        id: "judge-env-1",
        env: { kind: "repo", source: { files: { "judge.mjs": code, "judge-context.json": "{}" } } },
        task: "code judge",
        graders: [
          {
            id: "script",
            config: {
              language: "node",
              entrypoint: "judge.mjs",
              cwd: "work",
              contextPath: "judge-context.json",
              id: "judge",
            },
          },
        ],
        timeoutSec: 60,
        tags: ["judge"],
      },
      judge: { provider: "openai", model: "judge-model-x" },
      judgeAuth: { apiKey: "sk-job-key", baseUrl: "http://job-proxy" },
    };
    const result = await runAgentJob(job);
    const score = result.scores.find((s) => s.graderId === "judge");
    expect(score?.detail).toBe("judge-model-x sk-job-key http://job-proxy");
  });
});

// env.kind selects the Environment on the local agent path. browser is a service-topology target env and must
// never reach here — it should fail loud, not be silently mishandled as a repo.
describe("runAgentJob env.kind routing", () => {
  it("rejects a browser env on the local agent path instead of mishandling it as a repo", async () => {
    const job: AgentJob = {
      harness: { id: "scripted", version: "0.0.0" },
      evalCase: {
        id: "b1",
        env: { kind: "browser", startUrl: "https://example.com" },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };
    await expect(runAgentJob(job)).rejects.toThrow(/browser env is not runnable/);
  });
});

// Metering fail-safe (integration): the guard must key off container execution, and the CommandHarness must honor
// the resolved decision — rewriting the base URL host-native but leaving it untouched when containerized.
describe("runAgentJob meterUsage × containerize fail-safe", () => {
  const meteredJob = (): AgentJob => ({
    harness: { id: "probe", version: "1" },
    meterUsage: true,
    harnessSpec: {
      kind: "command",
      id: "probe",
      version: "1",
      setup: [],
      command: "echo base=$OPENAI_API_BASE",
      env: { OPENAI_API_BASE: "http://upstream.test/v1" },
      params: {},
      trace: { kind: "none" },
    },
    evalCase: { id: "m1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  });

  const finalText = (trace: Array<{ kind: string; text?: string }>): string =>
    trace.filter((e) => e.kind === "message").at(-1)?.text ?? "";

  it("host-native (LocalDriver): metering rewrites the child's base URL to the loopback proxy", async () => {
    const result = await runAgentJob(meteredJob());
    expect(finalText(result.trace)).toMatch(/base=http:\/\/127\.0\.0\.1:\d+/);
  });

  it("containerized: metering is disabled so the child keeps the real upstream URL", async () => {
    // explicit driver wins over containerize, so the case still executes host-side — but the guard must key off
    // containerize (what the runner passes for image-cases) and leave the env untouched.
    const result = await runAgentJob(meteredJob(), { driver: new LocalDriver(), containerize: true });
    expect(finalText(result.trace)).toContain("base=http://upstream.test/v1");
  });
});
