import type { AgentJob } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { runAgentJob } from "./run.js";

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
// every model call dies. runAgentJob must disable metering when the case is containerized.
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
    const { LocalDriver } = await import("@everdict/drivers");
    // explicit driver wins over containerize, so the case still executes host-side — but the guard must
    // key off containerize (what the runner passes for image-cases) and leave the env untouched.
    const result = await runAgentJob(meteredJob(), { driver: new LocalDriver(), containerize: true });
    expect(finalText(result.trace)).toContain("base=http://upstream.test/v1");
  });
});
