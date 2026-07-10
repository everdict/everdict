import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/contracts";

export interface SweBenchConfig {
  testPatch: string; // gold test diff (unified) — adds/modifies FAIL_TO_PASS tests
  failToPass: string[]; // tests that must pass after the fix (failing before it)
  passToPass: string[]; // tests that must keep passing after the fix
  testCmd?: string; // test runner (default "python -m pytest -q --no-header")
  cwd?: string; // repo working directory (default "work")
}

function shArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// SWE-bench scoring (official resolution definition): after applying the gold test_patch on top of the repo with the agent patch,
// run FAIL_TO_PASS (all must pass) + PASS_TO_PASS (all must hold) → resolved if all pass. Requires compute (an environment).
// Note: per-repo dependency install is handled by env.setup (or the official prebuilt image) — this grader only does "scoring".
export class SweBenchGrader implements Grader {
  readonly id = "swe-bench";
  readonly needsCompute = true; // Applies the gold patch + runs tests in the environment — must be graded before compute is released

  constructor(private readonly cfg: SweBenchConfig) {}

  async grade(ctx: GradeContext): Promise<Score> {
    if (!ctx.compute) {
      throw new BadRequestError("BAD_REQUEST", undefined, "The swe-bench grader requires compute (an environment).");
    }
    const cwd = this.cfg.cwd ?? "work";
    const testCmd = this.cfg.testCmd ?? "python -m pytest -q --no-header";

    // 1) Apply the gold test_patch. If it breaks, scoring is impossible → resolved=false.
    if (this.cfg.testPatch.trim()) {
      await ctx.compute.writeFile(`${cwd}/.everdict_test.patch`, this.cfg.testPatch);
      const applied = await ctx.compute.exec("git apply --verbose .everdict_test.patch", { cwd, timeoutSec: 120 });
      if (applied.exitCode !== 0) {
        return {
          graderId: this.id,
          metric: "resolved",
          value: 0,
          pass: false,
          detail: `test_patch apply failed: ${applied.stderr.slice(0, 500)}`,
        };
      }
    }

    // 2) Run FAIL_TO_PASS + PASS_TO_PASS. Exit code 0 ⟺ all selected tests pass ⟺ resolved.
    const tests = [...this.cfg.failToPass, ...this.cfg.passToPass];
    if (tests.length === 0) {
      return { graderId: this.id, metric: "resolved", value: 0, pass: false, detail: "no FAIL_TO_PASS/PASS_TO_PASS" };
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
