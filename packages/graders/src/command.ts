import { BadRequestError, type GradeContext, type Grader, type Score } from "@assay/core";

export interface CommandConfig {
  cmd: string; // 환경에서 실행할 명령(예: "python -m pytest -q")
  cwd?: string; // 작업 디렉터리(기본 "work")
  applyPatch?: string; // 채점 시점에 git apply 할 패치(예: 에이전트가 못 본 gold 테스트). 실패 시 pass=false.
  passPattern?: string; // stdout+stderr 정규식 매칭(없으면 종료코드 0 = pass)
  timeoutSec?: number;
  metric?: string; // 점수 메트릭 키(기본 "command")
  id?: string; // grader id(기본 "command")
}

function shArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// 제네릭 테스트-실행 grader — 벤치마크 무관. 유저가 데이터로 채점을 정의(코드 없이): 환경에서 명령 실행 →
// 종료코드(또는 출력 패턴)로 pass. 선택적으로 채점 시점에 gold 패치를 적용(SWE-bench 류). 의존성 설치는 env.setup.
// swe-bench grader 는 이 패턴(applyPatch + cmd)의 first-party 편의 프리셋이고, 새 벤치마크는 이 grader 로 충분하다.
export class CommandGrader implements Grader {
  readonly id: string;
  readonly metric: string;
  readonly needsCompute = true; // 환경에서 채점 명령 실행 — compute 해제 전에 채점되어야 한다
  constructor(private readonly cfg: CommandConfig) {
    this.id = cfg.id ?? "command";
    this.metric = cfg.metric ?? "command";
  }

  async grade(ctx: GradeContext): Promise<Score> {
    if (!ctx.compute) {
      throw new BadRequestError("BAD_REQUEST", undefined, "command 그레이더는 compute(환경)가 필요합니다.");
    }
    const cwd = this.cfg.cwd ?? "work";
    if (this.cfg.applyPatch?.trim()) {
      await ctx.compute.writeFile(`${cwd}/.assay_grade.patch`, this.cfg.applyPatch);
      const applied = await ctx.compute.exec(`git apply ${shArg(".assay_grade.patch")}`, { cwd, timeoutSec: 120 });
      if (applied.exitCode !== 0) {
        return {
          graderId: this.id,
          metric: this.metric,
          value: 0,
          pass: false,
          detail: `applyPatch 실패: ${applied.stderr.slice(0, 500)}`,
        };
      }
    }
    const r = await ctx.compute.exec(this.cfg.cmd, { cwd, timeoutSec: this.cfg.timeoutSec ?? 1800 });
    const out = `${r.stdout}${r.stderr}`;
    const pass = this.cfg.passPattern ? new RegExp(this.cfg.passPattern).test(out) : r.exitCode === 0;
    return { graderId: this.id, metric: this.metric, value: pass ? 1 : 0, pass, detail: out.slice(0, 2000) };
  }
}
