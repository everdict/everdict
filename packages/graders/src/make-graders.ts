import { BadRequestError, type Grader, type GraderSpec } from "@assay/core";
import { AnswerMatchGrader, DomContainsGrader, UrlMatchesGrader } from "./browser-graders.js";
import { CommandGrader } from "./command.js";
import { type Judge, JudgeGrader } from "./judge.js";
import { ScriptScoreGrader } from "./script-score.js";
import { SweBenchGrader } from "./swe-bench.js";
import { TestsPassGrader } from "./tests-pass.js";
import { costGrader, latencyGrader, stepsGrader } from "./trace-graders.js";

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// GraderSpec[] → Grader[]. judge(LLM/VLM)는 Judge 주입이 필요하므로 opts.judge 로 받는다(없는데 judge 스펙이면 명시 에러).
// 벤치마크별 채점 다양성은 EvalCase.graders 프리셋으로 표현된다(예: GAIA=answer-match exact, WebVoyager=judge,
// SWE-bench=tests-pass). 그 스펙을 여기서 Grader 인스턴스로 재구성한다.
export function makeGraders(specs: GraderSpec[], opts: { judge?: Judge } = {}): Grader[] {
  return specs.map((s) => {
    switch (s.id) {
      case "tests-pass":
        return new TestsPassGrader(String(s.config?.cmd ?? "true"));
      case "command":
        // 제네릭 테스트-실행 grader(벤치마크 무관, 유저 설정 가능): cmd + 선택적 gold 패치/출력 패턴.
        return new CommandGrader({
          cmd: String(s.config?.cmd ?? "true"),
          ...(optStr(s.config?.cwd) ? { cwd: optStr(s.config?.cwd) } : {}),
          ...(optStr(s.config?.applyPatch) ? { applyPatch: optStr(s.config?.applyPatch) } : {}),
          ...(optStr(s.config?.passPattern) ? { passPattern: optStr(s.config?.passPattern) } : {}),
          ...(optStr(s.config?.metric) ? { metric: optStr(s.config?.metric) } : {}),
          ...(optStr(s.config?.id) ? { id: optStr(s.config?.id) } : {}),
        });
      case "script-score":
        // 제네릭 숫자-점수 grader(벤치마크 무관): 채점 스크립트가 stdout 에 낸 연속 점수를 그대로 방출.
        return new ScriptScoreGrader({
          cmd: String(s.config?.cmd ?? "true"),
          ...(optStr(s.config?.cwd) ? { cwd: optStr(s.config?.cwd) } : {}),
          ...(optStr(s.config?.scorePattern) ? { scorePattern: optStr(s.config?.scorePattern) } : {}),
          ...(typeof s.config?.passThreshold === "number" ? { passThreshold: s.config.passThreshold } : {}),
          ...(typeof s.config?.timeoutSec === "number" ? { timeoutSec: s.config.timeoutSec } : {}),
          ...(optStr(s.config?.metric) ? { metric: optStr(s.config?.metric) } : {}),
          ...(optStr(s.config?.id) ? { id: optStr(s.config?.id) } : {}),
        });
      case "swe-bench":
        return new SweBenchGrader({
          testPatch: String(s.config?.testPatch ?? ""),
          failToPass: strArray(s.config?.failToPass),
          passToPass: strArray(s.config?.passToPass),
          ...(typeof s.config?.testCmd === "string" ? { testCmd: s.config.testCmd } : {}),
        });
      case "steps":
        return stepsGrader;
      case "cost":
        return costGrader;
      case "latency":
        return latencyGrader;
      case "dom-contains":
        return new DomContainsGrader(String(s.config?.text ?? ""));
      case "url-matches":
        return new UrlMatchesGrader(String(s.config?.pattern ?? ".*"));
      case "answer-match":
        return new AnswerMatchGrader(String(s.config?.expect ?? ""), s.config?.mode === "exact" ? "exact" : "contains");
      case "judge": {
        if (!opts.judge) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { grader: "judge" },
            "judge 그레이더는 Judge 주입이 필요합니다: makeGraders(specs, { judge }).",
          );
        }
        return new JudgeGrader(opts.judge, {
          id: typeof s.config?.id === "string" ? s.config.id : "judge",
          ...(typeof s.config?.rubric === "string" ? { rubric: s.config.rubric } : {}),
          useScreenshot: s.config?.useScreenshot === true,
        });
      }
      default:
        throw new BadRequestError("BAD_REQUEST", { grader: s.id });
    }
  });
}
