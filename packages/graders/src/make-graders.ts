import { BadRequestError, type Grader, type GraderSpec } from "@everdict/core";
import { AnswerMatchGrader, DomContainsGrader, UrlMatchesGrader } from "./browser-graders.js";
import { CommandGrader } from "./command.js";
import { type Judge, JudgeGrader } from "./judge.js";
import { ScriptScoreGrader } from "./script-score.js";
import { SweBenchGrader } from "./swe-bench.js";
import { TestsPassGrader } from "./tests-pass.js";
import { TextMetricGrader } from "./text-metric.js";
import { costGrader, latencyGrader, stepsGrader } from "./trace-graders.js";

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// GraderSpec[] → Grader[]. A judge (LLM/VLM) needs an injected Judge, so it's received via opts.judge (explicit error if a judge spec has none).
// Per-benchmark scoring variety is expressed as EvalCase.graders presets (e.g. GAIA=answer-match exact, WebVoyager=judge,
// SWE-bench=tests-pass). That spec is reconstructed into a Grader instance here.
export function makeGraders(specs: GraderSpec[], opts: { judge?: Judge } = {}): Grader[] {
  return specs.map((s) => {
    switch (s.id) {
      case "tests-pass":
        return new TestsPassGrader(String(s.config?.cmd ?? "true"));
      case "command":
        // Generic test-running grader (benchmark-agnostic, user-configurable): cmd + optional gold patch/output pattern.
        return new CommandGrader({
          cmd: String(s.config?.cmd ?? "true"),
          ...(optStr(s.config?.cwd) ? { cwd: optStr(s.config?.cwd) } : {}),
          ...(optStr(s.config?.applyPatch) ? { applyPatch: optStr(s.config?.applyPatch) } : {}),
          ...(optStr(s.config?.passPattern) ? { passPattern: optStr(s.config?.passPattern) } : {}),
          ...(optStr(s.config?.metric) ? { metric: optStr(s.config?.metric) } : {}),
          ...(optStr(s.config?.id) ? { id: optStr(s.config?.id) } : {}),
        });
      case "script-score":
        // Generic numeric-score grader (benchmark-agnostic): emits the continuous score the scoring script wrote to stdout as-is.
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
      case "text-metric":
        // Numeric metric recovered from the agent's printed output (trace:none stdout tail) — pattern/metric are required data.
        return new TextMetricGrader({
          pattern: String(s.config?.pattern ?? ""),
          metric: String(s.config?.metric ?? ""),
          ...(optStr(s.config?.id) ? { id: optStr(s.config?.id) } : {}),
        });
      case "judge": {
        if (!opts.judge) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { grader: "judge" },
            "The judge grader requires Judge injection: makeGraders(specs, { judge }).",
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
