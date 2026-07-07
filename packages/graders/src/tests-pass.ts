import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/core";

// ⓐ 과업 성공(객관적) — 환경에서 테스트 명령을 실행하고 종료코드로 판정. compute(환경) 필요.
export class TestsPassGrader implements Grader {
  readonly id = "tests-pass";
  readonly needsCompute = true; // 환경에서 테스트 실행 — compute 해제 전에 채점되어야 한다

  constructor(
    private readonly testCmd: string,
    private readonly cwd = "work",
  ) {}

  async grade(ctx: GradeContext): Promise<Score> {
    if (!ctx.compute)
      throw new BadRequestError("BAD_REQUEST", undefined, "tests-pass 그레이더는 compute(환경)가 필요합니다.");
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
