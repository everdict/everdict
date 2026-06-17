import type { AgentJob } from "@assay/core";
import { describe, expect, it } from "vitest";
import { runAgentJob } from "./run.js";

describe("runAgentJob", () => {
  it("scripted 잡을 실행해 CaseResult 를 만들고 tests-pass 가 통과한다", async () => {
    const job: AgentJob = {
      harness: { id: "scripted", version: "0.0.0" },
      evalCase: {
        id: "agent-1",
        env: { kind: "repo", source: { files: { "seed.txt": "x\n" } } },
        task: "out.txt 만들기",
        graders: [{ id: "steps" }, { id: "tests-pass", config: { cmd: "test -f out.txt" } }],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await runAgentJob(job);

    expect(result.harness).toBe("scripted@0.0.0");
    const pass = result.scores.find((s) => s.graderId === "tests-pass");
    expect(pass?.pass).toBe(true);
    expect(result.snapshot.changedFiles).toContain("out.txt");
  });
});
