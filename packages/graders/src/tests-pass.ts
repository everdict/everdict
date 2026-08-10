import { BadRequestError, type GradeContext, type Grader, type MeasuredScore } from "@everdict/contracts";

// ⓐ Task success (objective) — runs the test command in the environment and decides by exit code. Requires compute (an environment).
export class TestsPassGrader implements Grader {
  readonly id = "tests-pass";
  // INTRINSIC authority (arch-review 17 P0-2): this grader's metric name is fixed in its own code, not taken
  // from config or from a script's stdout, so the ladder's assignment for it is a property of the
  // implementation. Declared on the CLASS rather than stamped at construction, so it cannot be lost by a call
  // site that builds the grader directly instead of going through `makeGraders`.
  readonly declaredAuthority = "ground_truth" as const;
  readonly needsCompute = true; // Runs tests in the environment — must be graded before compute is released

  constructor(
    private readonly testCmd: string,
    private readonly cwd = "work",
  ) {}

  async grade(ctx: GradeContext): Promise<MeasuredScore> {
    if (!ctx.compute)
      throw new BadRequestError("BAD_REQUEST", undefined, "The tests-pass grader requires compute (an environment).");
    const r = await ctx.compute.exec(this.testCmd, { cwd: this.cwd, timeoutSec: 600 });
    const pass = r.exitCode === 0;
    return {
      graderId: this.id,
      metric: "tests_pass",
      value: pass ? 1 : 0,
      pass,
      detail: `${r.stdout}${r.stderr}`.slice(0, 2000),
    };
  }
}
