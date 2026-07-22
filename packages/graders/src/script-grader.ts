import {
  BadRequestError,
  type ComputeHandle,
  type GradeContext,
  type Grader,
  type Score,
  ScoreSchema,
  UpstreamError,
  toScores,
} from "@everdict/contracts";

export interface ScriptGraderConfig {
  language: "python" | "node"; // interpreter inside the grading compute (python3 / node)
  code?: string; // inline grader source — written into the compute at grading time
  entrypoint?: string; // OR a path to a grader script already present (case image / repo / grader image)
  // Dedicated grader image — grade in an OWN provisioned container (ctx.provision) instead of the case compute.
  // The case sandbox is not held for grading (observation-family) and the grader deps live in the grader image.
  image?: string;
  cwd?: string; // working directory for the run (default "work" in the case compute; the image's default in image mode)
  // Grade a PRE-SERIALIZED context file already present in the environment (path relative to cwd) instead of this
  // job's own context — the code-judge wrapper path: the ORIGINAL case's context is materialized as an env file and
  // the wrapper job's own (synthetic) context is ignored. The script contract stays identical (argv[1] = context path).
  contextPath?: string;
  timeoutSec?: number;
  id?: string; // grader id (default "script")
}

// Where the grading contract is materialized inside the compute. Fixed paths — the script receives the context
// path as argv[1], so user code stays path-agnostic.
const CONTEXT_PATH = "/tmp/everdict-grade-context.json";
const INLINE_PATH: Record<ScriptGraderConfig["language"], string> = {
  python: "/tmp/everdict-grader.py",
  node: "/tmp/everdict-grader.mjs",
};
const INTERPRETER: Record<ScriptGraderConfig["language"], string> = { python: "python3", node: "node" };

// The last thing on stdout must be the verdict JSON — logs before it are allowed.
function extractJson(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return trimmed;
  return /(\[[\s\S]*\]|\{[\s\S]*\})\s*$/.exec(stdout)?.[1];
}

// Custom grader — the user's own Python/TS scorer over the FULL grading context (docs/architecture/eval-domain-model.md S4).
// Contract: the serialized GradeContext ({case, trace, snapshot} — everything but the live compute handle) is written
// into the compute; the script runs as `<interpreter> <script> <context-path>` and prints a Score or Score[] JSON as
// the LAST thing on stdout. Default mode runs inside the case's already-isolated compute (needsCompute), so user code
// is sandboxed exactly like the agent under test; `image` mode provisions a DEDICATED grader container instead
// (observation-family — the case sandbox is released first) and disposes it in a finally.
// graderId is stamped with this grader's id (provenance is the runner's, not the script's).
export class ScriptGrader implements Grader {
  readonly id: string;
  readonly needsCompute: boolean;
  constructor(private readonly cfg: ScriptGraderConfig) {
    this.id = cfg.id ?? "script";
    this.needsCompute = !cfg.image; // image mode grades in its own container — the case compute is not held
    if (!cfg.code && !cfg.entrypoint) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { grader: this.id },
        "The script grader requires config.code (inline source) or config.entrypoint (a path in the environment).",
      );
    }
  }

  async grade(ctx: GradeContext): Promise<Score[]> {
    if (this.cfg.image) {
      if (!ctx.provision) {
        throw new BadRequestError(
          "BAD_REQUEST",
          { grader: this.id, image: this.cfg.image },
          "The script grader's image mode needs a provisioning driver (process-harness runCase path only).",
        );
      }
      const dedicated = await ctx.provision({ os: "linux", needs: ["shell"], image: this.cfg.image });
      try {
        return await this.runIn(dedicated, ctx);
      } finally {
        await dedicated.dispose();
      }
    }
    if (!ctx.compute) {
      throw new BadRequestError("BAD_REQUEST", undefined, "The script grader requires compute (an environment).");
    }
    return this.runIn(ctx.compute, ctx);
  }

  private async runIn(compute: ComputeHandle, ctx: GradeContext): Promise<Score[]> {
    let contextArg = this.cfg.contextPath;
    if (!contextArg) {
      // Full context minus the live handle — JSON-serializable by construction (EvalCase/TraceEvent[]/EnvSnapshot;
      // evidence = the pulled-trace extraction, when present).
      await compute.writeFile(
        CONTEXT_PATH,
        JSON.stringify({
          case: ctx.case,
          trace: ctx.trace,
          snapshot: ctx.snapshot,
          ...(ctx.evidence ? { evidence: ctx.evidence } : {}),
        }),
      );
      contextArg = CONTEXT_PATH;
    }
    let script = this.cfg.entrypoint;
    if (this.cfg.code) {
      script = INLINE_PATH[this.cfg.language];
      await compute.writeFile(script, this.cfg.code);
    }
    if (!script) throw new BadRequestError("BAD_REQUEST", { grader: this.id }, "No grader script to run.");
    const cmd = `${INTERPRETER[this.cfg.language]} '${script.replace(/'/g, "'\\''")}' '${contextArg.replace(/'/g, "'\\''")}'`;
    // The case compute has the "work" convention; a dedicated grader image keeps its own default workdir.
    const cwd = this.cfg.cwd ?? (this.cfg.image ? undefined : "work");
    const r = await compute.exec(cmd, { ...(cwd ? { cwd } : {}), timeoutSec: this.cfg.timeoutSec ?? 1800 });
    if (r.exitCode !== 0) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { grader: this.id, exitCode: r.exitCode },
        `custom grader exited ${r.exitCode}: ${`${r.stderr}${r.stdout}`.slice(0, 500)}`,
      );
    }
    const json = extractJson(r.stdout);
    if (!json) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { grader: this.id },
        `custom grader printed no Score JSON: ${r.stdout.slice(0, 500)}`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { grader: this.id },
        `custom grader output is not valid JSON: ${json.slice(0, 500)}`,
      );
    }
    const parsed = ScoreSchema.or(ScoreSchema.array().min(1)).safeParse(raw);
    if (!parsed.success) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { grader: this.id, issues: parsed.error.issues.map((i) => i.message) },
        "custom grader output is not in Score / Score[] format ({graderId, metric, value, pass?, label?, detail?}). Emit `label` for a categorical/tier metric (e.g. {metric:'tier', value:3, label:'gold'}).",
      );
    }
    return toScores(parsed.data).map((s) => ({ ...s, graderId: this.id }));
  }
}
