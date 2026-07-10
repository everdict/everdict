import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/contracts";

export interface ScriptScoreConfig {
  cmd: string; // Scoring command to run in the environment — writes a continuous score to stdout (e.g. "python3 .grader/pinch_score.py …")
  cwd?: string; // Working directory (default "work")
  scorePattern?: string; // Regex that extracts the score from stdout+stderr (capture group 1 = number). Default "SCORE=([-\\d.]+)"
  passThreshold?: number; // pass threshold (default 0.6)
  timeoutSec?: number;
  metric?: string; // Score metric key (default "score")
  id?: string; // grader id (default "script-score")
}

// Generic numeric-score grader — runs the command and parses the **continuous score** the scoring script computed from stdout, emitting it as-is.
// In contrast to the command grader, which only yields exit-code→binary (pass/fail): the scoring logic (automated checks, LLM judging, weighted
// combination, etc.) lives in data (the script), and here we only move that resulting number into Score.value. E.g. PinchBench's automated+judge
// weighted-combination mean. A match failure (no score printed) is handled explicitly as value=0·pass=false and noted in detail (not a silent default).
export class ScriptScoreGrader implements Grader {
  readonly id: string;
  readonly metric: string;
  readonly needsCompute = true; // Runs the scoring script in the environment — must be graded before compute is released
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
      throw new BadRequestError("BAD_REQUEST", undefined, "The script-score grader requires compute (an environment).");
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
      : `[no score printed: pattern '${this.pattern.source}' did not match] ${out.slice(0, 1900)}`;
    return { graderId: this.id, metric: this.metric, value, pass: value >= this.threshold, detail };
  }
}
