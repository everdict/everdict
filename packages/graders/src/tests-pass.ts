import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/contracts";

// ⓐ Task success (objective) — runs the test command in the environment and decides by exit code. Requires compute (an environment).
export class TestsPassGrader implements Grader {
  readonly id = "tests-pass";
  readonly needsCompute = true; // Runs tests in the environment — must be graded before compute is released

  constructor(
    private readonly testCmd: string,
    private readonly cwd = "work",
  ) {}

  async grade(ctx: GradeContext): Promise<Score> {
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
