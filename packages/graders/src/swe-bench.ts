import { BadRequestError, type GradeContext, type Grader, type Score } from "@assay/core";

export interface SweBenchConfig {
  testPatch: string; // gold test diff(unified) — FAIL_TO_PASS 테스트를 추가/변경
  failToPass: string[]; // 수정 후 통과해야 하는 테스트(수정 전엔 실패)
  passToPass: string[]; // 수정 후에도 유지돼야 하는 테스트
  testCmd?: string; // 테스트 러너(기본 "python -m pytest -q --no-header")
  cwd?: string; // repo 작업 디렉터리(기본 "work")
}

function shArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// SWE-bench 채점(공식 resolution 정의): 에이전트 패치가 적용된 repo 에 gold test_patch 를 입힌 뒤
// FAIL_TO_PASS(전부 통과해야) + PASS_TO_PASS(전부 유지) 를 실행 → 모두 통과면 resolved. compute(환경) 필요.
// 참고: per-repo 의존성 설치는 env.setup(또는 공식 prebuilt 이미지)이 담당 — 이 그레이더는 "채점"만.
export class SweBenchGrader implements Grader {
  readonly id = "swe-bench";
  constructor(private readonly cfg: SweBenchConfig) {}

  async grade(ctx: GradeContext): Promise<Score> {
    if (!ctx.compute) {
      throw new BadRequestError("BAD_REQUEST", undefined, "swe-bench 그레이더는 compute(환경)가 필요합니다.");
    }
    const cwd = this.cfg.cwd ?? "work";
    const testCmd = this.cfg.testCmd ?? "python -m pytest -q --no-header";

    // 1) gold test_patch 적용. 깨지면 채점 불가 → resolved=false.
    if (this.cfg.testPatch.trim()) {
      await ctx.compute.writeFile(`${cwd}/.assay_test.patch`, this.cfg.testPatch);
      const applied = await ctx.compute.exec("git apply --verbose .assay_test.patch", { cwd, timeoutSec: 120 });
      if (applied.exitCode !== 0) {
        return {
          graderId: this.id,
          metric: "resolved",
          value: 0,
          pass: false,
          detail: `test_patch 적용 실패: ${applied.stderr.slice(0, 500)}`,
        };
      }
    }

    // 2) FAIL_TO_PASS + PASS_TO_PASS 를 실행. 종료코드 0 ⟺ 선택된 테스트 전부 통과 ⟺ resolved.
    const tests = [...this.cfg.failToPass, ...this.cfg.passToPass];
    if (tests.length === 0) {
      return { graderId: this.id, metric: "resolved", value: 0, pass: false, detail: "FAIL_TO_PASS/PASS_TO_PASS 없음" };
    }
    const r = await ctx.compute.exec(`${testCmd} ${tests.map(shArg).join(" ")}`, { cwd, timeoutSec: 1800 });
    const pass = r.exitCode === 0;
    return {
      graderId: this.id,
      metric: "resolved",
      value: pass ? 1 : 0,
      pass,
      detail: `${pass ? "RESOLVED" : "UNRESOLVED"} · F2P=${this.cfg.failToPass.length} P2P=${this.cfg.passToPass.length}\n${`${r.stdout}${r.stderr}`.slice(0, 1500)}`,
    };
  }
}
