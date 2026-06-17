import type { EvalCase } from "@assay/core";
import { LocalDriver } from "@assay/drivers";
import { RepoEnvironment } from "@assay/environments";
import { TestsPassGrader, costGrader, stepsGrader } from "@assay/graders";
import { ScriptedHarness } from "@assay/harnesses";
import { describe, expect, it } from "vitest";
import { runCase } from "./run-case.js";

describe("runCase — 실제 하니스 실행 → 트레이스 → 채점 (전체 루프)", () => {
  it("스크립트 하니스가 버그를 고치면 tests-pass 그레이더가 통과한다", async () => {
    const evalCase: EvalCase = {
      id: "demo-1",
      env: {
        kind: "repo",
        source: {
          files: {
            "value.txt": "0\n",
            "check.sh": 'test "$(cat value.txt)" = "42"\n',
          },
        },
      },
      task: "value.txt 의 값을 42 로 고쳐줘",
      graders: ["tests-pass", "steps", "cost"],
      timeoutSec: 120,
      tags: [],
    };

    const result = await runCase(evalCase, {
      driver: new LocalDriver(),
      environment: new RepoEnvironment(),
      // 하니스가 task를 받아 compute에서 실제 명령을 실행한다.
      harness: new ScriptedHarness("0.0.0", () => [{ tool: "bash", cmd: "echo 42 > value.txt" }]),
      graders: [new TestsPassGrader("sh check.sh"), stepsGrader, costGrader],
      runCtx: { apiKeyEnv: {}, timeoutSec: 120 },
    });

    // 실제 실행에서 나온 산출물을 눈으로 확인 (테스트가 곧 데모).
    console.log(`\n=== TRACE ===\n${result.trace.map((e) => JSON.stringify(e)).join("\n")}`);
    console.log(`\n=== SCORES ===\n${result.scores.map((s) => JSON.stringify(s)).join("\n")}`);
    console.log(`\n=== DIFF ===\n${result.snapshot.diff}`);

    expect(result.harness).toBe("scripted@0.0.0");
    const pass = result.scores.find((s) => s.graderId === "tests-pass");
    expect(pass?.pass).toBe(true);
    const steps = result.scores.find((s) => s.graderId === "steps");
    expect(steps?.value).toBeGreaterThan(0);
    expect(result.snapshot.changedFiles).toContain("value.txt");
  });
});
