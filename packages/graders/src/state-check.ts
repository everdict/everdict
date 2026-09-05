import { BUILTIN_GRADER_OWNED_METRICS, type GradeContext, type Grader, type MeasuredScore } from "@everdict/contracts";
import { CommandGrader } from "./command.js";

export interface StateCheckConfig {
  cmd: string; // the verification command — exit code 0 (or `passPattern`) means the world is in the expected state
  cwd?: string; // default "work"; an os-use case has no work directory and passes an absolute path
  passPattern?: string;
  timeoutSec?: number;
}

// ⓐ Verified system STATE (ground truth) — runs a check command against the world the agent left behind (a file
// exists, a setting took, a folder was created) and decides by exit code. The portable counterpart of an OSWorld
// evaluator. It is `command` with the metric FIXED to `state`, and that is the whole point of its existence: the
// metric name carries ground-truth authority, so it belongs to a grader that produces it BY CONSTRUCTION
// (`BUILTIN_GRADER_OWNED_METRICS`) — a generic `command` grader configured with `metric: "state"` owns nothing and
// is refused at both authority seams. Same shape as `TestsPassGrader` over `tests_pass`.
export class StateCheckGrader implements Grader {
  readonly id = "state-check";
  readonly ownsMetrics = BUILTIN_GRADER_OWNED_METRICS["state-check"];
  readonly needsCompute = true; // Runs the check in the environment — must be graded before compute is released
  private readonly runner: CommandGrader;

  constructor(cfg: StateCheckConfig) {
    this.runner = new CommandGrader({ ...cfg, id: this.id, metric: this.ownsMetrics[0] });
  }

  async grade(ctx: GradeContext): Promise<MeasuredScore> {
    return this.runner.grade(ctx);
  }
}
