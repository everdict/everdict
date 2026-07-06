import { BadRequestError, type GradeContext, type Grader, type Score } from "@assay/core";

export interface ScriptScoreConfig {
  cmd: string; // 환경에서 실행할 채점 명령 — stdout 에 연속 점수를 낸다(예: "python3 .grader/pinch_score.py …")
  cwd?: string; // 작업 디렉터리(기본 "work")
  scorePattern?: string; // stdout+stderr 에서 점수를 뽑는 정규식(캡처그룹 1 = 숫자). 기본 "SCORE=([-\\d.]+)"
  passThreshold?: number; // pass 기준(기본 0.6)
  timeoutSec?: number;
  metric?: string; // 점수 메트릭 키(기본 "score")
  id?: string; // grader id(기본 "script-score")
}

// 제네릭 숫자-점수 grader — 명령을 실행하고 stdout 에서 채점 스크립트가 계산한 **연속 점수**를 파싱해 그대로 방출한다.
// command grader 가 종료코드→이진(pass/fail)만 내는 것과 대비: 채점 로직(자동검사·LLM판정·가중결합 등)은 데이터(스크립트)에
// 두고, 여기서는 그 결과 숫자만 Score.value 로 옮긴다. 예: PinchBench 의 automated+judge 가중결합 mean.
// 매칭 실패(점수 미출력)는 명시적으로 value=0·pass=false 로 처리하고 detail 에 표시한다(무성 기본값 아님).
export class ScriptScoreGrader implements Grader {
  readonly id: string;
  readonly metric: string;
  readonly needsCompute = true; // 환경에서 채점 스크립트 실행 — compute 해제 전에 채점되어야 한다
  private readonly pattern: RegExp;
  private readonly threshold: number;
  constructor(private readonly cfg: ScriptScoreConfig) {
    this.id = cfg.id ?? "script-score";
    this.metric = cfg.metric ?? "score";
    this.pattern = new RegExp(cfg.scorePattern ?? "SCORE=([-\\d.]+)");
    this.threshold = cfg.passThreshold ?? 0.6;
  }

  async grade(ctx: GradeContext): Promise<Score> {
    if (!ctx.compute) {
      throw new BadRequestError("BAD_REQUEST", undefined, "script-score 그레이더는 compute(환경)가 필요합니다.");
    }
    const cwd = this.cfg.cwd ?? "work";
    const r = await ctx.compute.exec(this.cfg.cmd, { cwd, timeoutSec: this.cfg.timeoutSec ?? 1800 });
    const out = `${r.stdout}${r.stderr}`;
    const captured = this.pattern.exec(out)?.[1];
    const parsed = captured !== undefined ? Number.parseFloat(captured) : Number.NaN;
    const matched = Number.isFinite(parsed);
    const value = matched ? parsed : 0;
    const detail = matched
      ? out.slice(0, 2000)
      : `[점수 미출력: 패턴 '${this.pattern.source}' 불일치] ${out.slice(0, 1900)}`;
    return { graderId: this.id, metric: this.metric, value, pass: value >= this.threshold, detail };
  }
}
