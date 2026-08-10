import { BadRequestError, type Grader, type GraderSpec, JudgeCriterionSchema } from "@everdict/contracts";
import { AnswerMatchGrader, DomContainsGrader, UrlMatchesGrader } from "./browser-graders.js";
import { CommandGrader } from "./command.js";
import { type Judge, JudgeGrader } from "./judge.js";
import { ScriptGrader } from "./script-grader.js";
import { ScriptScoreGrader } from "./script-score.js";
import { StoreStateGrader } from "./store-state.js";
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
  // THE TRUSTED CONSTRUCTION BOUNDARY (arch-review 17 P0-2). This is the one place that reads a GraderSpec
  // and produces the object that will later emit scores, so it is where the spec's DECLARED authority is
  // stamped onto the instance. The collection boundary then knows whether a grader emitting `state` holds a
  // declaration (constitution-gated at submit) or is merely printing a reserved word — a distinction the
  // grader's own output can never establish about itself.
  return specs.map((s) => withDeclaredAuthority(buildGrader(s, opts), s));
}

// The ONE thing a spec may grant: the code-judge WRAPPER's right to emit the inline judge's shapes
// (arch-review 18 P0-1). A code judge executes as a `script` grader inside a job the control plane builds,
// and that builder declares `authority: "judge"` on the spec it emits — there is no other way for the inner
// collection boundary, which sees only a CaseJob, to tell that wrapper apart from any other user script.
//
// What a spec can NEVER grant is a reserved authority NAME. Those belong to the graders that produce them by
// construction (declared on the implementation), because treating "declared something" as the permit made
// every declaration a wildcard: `authority: "observational"` needs no admin and would have bought `state`.
function withDeclaredAuthority(grader: Grader, spec: GraderSpec): Grader {
  // A spec that NAMES its metrics owns those names (arch-review 19 P1) — that IS the declaration, made by the
  // dataset author and gated at submit for ground truth. Without it a grader declaring `metrics: [{id:"state",
  // authority:"ground_truth"}]` would compose a policy entry for `state` and then have its own score
  // invalidated for emitting it, which is the two halves of one declaration disagreeing.
  const owned = (spec.metrics ?? []).map((m) => m.id);
  const patch = {
    ...(owned.length > 0 ? { ownsMetrics: owned } : {}),
    ...(spec.authority === "judge" ? { ownsJudgeVerdict: true } : {}),
  };
  if (Object.keys(patch).length === 0) return grader;
  return Object.assign(Object.create(Object.getPrototypeOf(grader)), grader, patch);
}

function buildGrader(s: GraderSpec, opts: { judge?: Judge }): Grader {
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
    case "script": {
      // Custom grader (user Python/TS code over the full serialized GradeContext) — see script-grader.ts for the contract.
      const language = s.config?.language;
      if (language !== "python" && language !== "node") {
        throw new BadRequestError(
          "BAD_REQUEST",
          { grader: "script" },
          'The script grader requires config.language: "python" | "node".',
        );
      }
      return new ScriptGrader({
        language,
        ...(optStr(s.config?.code) ? { code: optStr(s.config?.code) } : {}),
        ...(optStr(s.config?.entrypoint) ? { entrypoint: optStr(s.config?.entrypoint) } : {}),
        ...(optStr(s.config?.image) ? { image: optStr(s.config?.image) } : {}),
        ...(optStr(s.config?.cwd) ? { cwd: optStr(s.config?.cwd) } : {}),
        ...(optStr(s.config?.contextPath) ? { contextPath: optStr(s.config?.contextPath) } : {}),
        ...(typeof s.config?.timeoutSec === "number" ? { timeoutSec: s.config.timeoutSec } : {}),
        ...(optStr(s.config?.id) ? { id: optStr(s.config?.id) } : {}),
      });
    }
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
      // No expect config → undefined (NOT ""), so the grader can fall back to the case's own `expected` row data.
      return new AnswerMatchGrader(optStr(s.config?.expect), s.config?.mode === "exact" ? "exact" : "contains");
    case "store-state":
      // Grade the POST-RUN state of a data store (P2): read the case's slice via ctx.readStore (topology runtime) and
      // compare to expected. store/query are required data; expect falls back to the case's own `expected`.
      return new StoreStateGrader({
        store: String(s.config?.store ?? "postgres"),
        ...(optStr(s.config?.role) ? { role: optStr(s.config?.role) } : {}),
        query: String(s.config?.query ?? ""),
        ...(optStr(s.config?.expect) ? { expect: optStr(s.config?.expect) } : {}),
        ...(s.config?.mode === "exact" ? { mode: "exact" as const } : {}),
      });
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
      // Inline judge parity with registered JudgeSpecs: criteria/promptTemplate ride the grader config too.
      const criteria = JudgeCriterionSchema.array().min(1).safeParse(s.config?.criteria);
      return new JudgeGrader(opts.judge, {
        id: typeof s.config?.id === "string" ? s.config.id : "judge",
        // The INLINE construction — its scores reach the plane unrewritten, so its criteria namespace
        // themselves here (arch-review 19 P1). The registered runner and the code-judge wrapper build their
        // own JudgeGrader and apply the runner's rewrite instead; setting it there would double it.
        namespaceCriteria: true,
        ...(typeof s.config?.rubric === "string" ? { rubric: s.config.rubric } : {}),
        ...(criteria.success ? { criteria: criteria.data } : {}),
        ...(typeof s.config?.promptTemplate === "string" ? { promptTemplate: s.config.promptTemplate } : {}),
        useScreenshot: s.config?.useScreenshot === true,
      });
    }
    default:
      throw new BadRequestError("BAD_REQUEST", { grader: s.id });
  }
}
