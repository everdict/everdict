import type { GradeContext, Grader, Score, TraceEvent } from "@assay/core";

export interface JudgeVerdict {
  pass: boolean;
  score: number;
  reason: string;
}

// 모델 기반 판정 추상화 (LLM/VLM). 구체 구현(실모델 호출)은 주입한다.
export interface Judge {
  judge(input: {
    task: string;
    trace?: TraceEvent[];
    dom?: string;
    screenshotRef?: string;
    rubric?: string;
  }): Promise<JudgeVerdict>;
}

// LLM/VLM judge 그레이더. dom/screenshot 을 함께 넘기면 브라우저 결과를 판정한다.
export class JudgeGrader implements Grader {
  readonly id: string;
  constructor(
    private readonly judge: Judge,
    private readonly opts: { id?: string; rubric?: string; useScreenshot?: boolean } = {},
  ) {
    this.id = opts.id ?? "judge";
  }

  async grade(ctx: GradeContext): Promise<Score> {
    const snap = ctx.snapshot;
    const verdict = await this.judge.judge({
      task: ctx.case.task,
      trace: ctx.trace,
      dom: snap.kind === "browser" ? snap.dom : undefined,
      screenshotRef: snap.kind === "browser" && this.opts.useScreenshot ? snap.screenshotRef : undefined,
      rubric: this.opts.rubric,
    });
    return { graderId: this.id, metric: "judge", value: verdict.score, pass: verdict.pass, detail: verdict.reason };
  }
}
