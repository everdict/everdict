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
