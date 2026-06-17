import { BadRequestError, type Grader, type GraderSpec } from "@assay/core";
import { DomContainsGrader, UrlMatchesGrader } from "./browser-graders.js";
import { TestsPassGrader } from "./tests-pass.js";
import { costGrader, latencyGrader, stepsGrader } from "./trace-graders.js";

// GraderSpec[] → Grader[] (의존성 없는 그레이더). judge(LLM/VLM)는 Judge 주입이 필요해 여기 없음.
export function makeGraders(specs: GraderSpec[]): Grader[] {
  return specs.map((s) => {
    switch (s.id) {
      case "tests-pass":
        return new TestsPassGrader(String(s.config?.cmd ?? "true"));
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
      default:
        throw new BadRequestError("BAD_REQUEST", { grader: s.id });
    }
  });
}
