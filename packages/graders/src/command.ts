import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/core";

export interface CommandConfig {
  cmd: string; // Command to run in the environment (e.g. "python -m pytest -q")
  cwd?: string; // Working directory (default "work")
  applyPatch?: string; // Patch to git apply at grading time (e.g. gold tests the agent never saw). pass=false on failure.
  passPattern?: string; // stdout+stderr regex match (absent → exit code 0 = pass)
  timeoutSec?: number;
  metric?: string; // Score metric key (default "command")
  id?: string; // grader id (default "command")
}

function shArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Generic test-running grader — benchmark-agnostic. The user defines grading as data (no code): run a command in the
// environment → pass by exit code (or output pattern). Optionally apply a gold patch at grading time (SWE-bench-style).
// Dependency install is env.setup. The swe-bench grader is a first-party convenience preset of this pattern
// (applyPatch + cmd), and this grader suffices for new benchmarks.
export class CommandGrader implements Grader {
  readonly id: string;
  readonly metric: string;
  readonly needsCompute = true; // Runs the grading command in the environment — must be graded before compute is released
  constructor(private readonly cfg: CommandConfig) {
    this.id = cfg.id ?? "command";
    this.metric = cfg.metric ?? "command";
  }

  async grade(ctx: GradeContext): Promise<Score> {
    if (!ctx.compute) {
      throw new BadRequestError("BAD_REQUEST", undefined, "The command grader requires compute (an environment).");
    }
    const cwd = this.cfg.cwd ?? "work";
    if (this.cfg.applyPatch?.trim()) {
      await ctx.compute.writeFile(`${cwd}/.everdict_grade.patch`, this.cfg.applyPatch);
      const applied = await ctx.compute.exec(`git apply ${shArg(".everdict_grade.patch")}`, { cwd, timeoutSec: 120 });
      if (applied.exitCode !== 0) {
        return {
          graderId: this.id,
          metric: this.metric,
          value: 0,
          pass: false,
          detail: `applyPatch failed: ${applied.stderr.slice(0, 500)}`,
        };
      }
    }
    const r = await ctx.compute.exec(this.cfg.cmd, { cwd, timeoutSec: this.cfg.timeoutSec ?? 1800 });
    const out = `${r.stdout}${r.stderr}`;
    const pass = this.cfg.passPattern ? new RegExp(this.cfg.passPattern).test(out) : r.exitCode === 0;
    return { graderId: this.id, metric: this.metric, value: pass ? 1 : 0, pass, detail: out.slice(0, 2000) };
  }
}
