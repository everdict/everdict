import type { ComputeHandle, EnvSnapshot, GradeContext, Grader, Score, TraceEvent } from "@everdict/core";

export interface JudgeVerdict {
  pass: boolean;
  score: number;
  reason: string;
}

// Image (screenshot) bytes passed to VLM judging. The ref (path) is read from the environment by the grader and resolved to base64.
export interface JudgeImage {
  base64: string;
  mediaType: string; // e.g. "image/png"
}

// Model-based judging abstraction (LLM/VLM). The concrete implementation (real model call) is injected.
export interface Judge {
  judge(input: {
    task: string;
    trace?: TraceEvent[];
    dom?: string;
    screenshotRef?: string; // External ref such as a browser snapshot (model transport uses screenshot)
    screenshot?: JudgeImage; // Image bytes resolved for VLM input
    rubric?: string;
  }): Promise<JudgeVerdict>;
}

function mediaTypeFor(path: string): string {
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
}

// Resolves the screenshot of an os-use/browser snapshot into VLM input (base64). If embedded base64 exists, use it as-is (no compute +
// works after dispose too — result-scoring path). For os-use, if absent, fall back to reading directly from the compute file (live run path).
// For browser (service-topology: browser-use etc.), the front-door embeds the final page screenshot as base64 → as VLM judge input, like the
// official WebVoyager (GPT-4V). (browser's screenshotRef may be an external storage URL, so the compute fallback is os-use only.)
async function resolveScreenshot(snap: EnvSnapshot, compute?: ComputeHandle): Promise<JudgeImage | undefined> {
  if ((snap.kind === "os-use" || snap.kind === "browser") && snap.screenshot) {
    return { base64: snap.screenshot, mediaType: mediaTypeFor(snap.screenshotRef || ".png") };
  }
  if (snap.kind !== "os-use") return undefined;
  if (!snap.screenshotRef || !compute) return undefined;
  const ref = snap.screenshotRef;
  const r = await compute.exec(`base64 -w0 '${ref.replace(/'/g, "'\\''")}'`);
  const base64 = r.stdout.trim();
  if (r.exitCode !== 0 || !base64) return undefined;
  return { base64, mediaType: mediaTypeFor(ref) };
}

// LLM/VLM judge grader. When useScreenshot, passes the snapshot's screenshot as vision input (browser=ref, os-use=read from the environment as bytes).
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
    const screenshot = this.opts.useScreenshot ? await resolveScreenshot(snap, ctx.compute) : undefined;
    const verdict = await this.judge.judge({
      task: ctx.case.task,
      trace: ctx.trace,
      dom: snap.kind === "browser" ? snap.dom : undefined,
      screenshotRef: snap.kind === "browser" && this.opts.useScreenshot ? snap.screenshotRef : undefined,
      ...(screenshot ? { screenshot } : {}),
      rubric: this.opts.rubric,
    });
    return { graderId: this.id, metric: "judge", value: verdict.score, pass: verdict.pass, detail: verdict.reason };
  }
}
