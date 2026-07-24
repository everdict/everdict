import type {
  ComputeHandle,
  EnvSnapshot,
  EvalCase,
  GradeContext,
  Grader,
  JudgeCriterion,
  Score,
  TraceEvent,
} from "@everdict/contracts";

export interface CriterionVerdict {
  pass: boolean;
  score: number;
  reason: string;
}

export interface JudgeVerdict {
  pass: boolean;
  score: number;
  reason: string;
  criteria?: Record<string, CriterionVerdict>; // per-criterion verdicts when the judge was given criteria
}

// Image (screenshot) bytes passed to VLM judging. The ref (path) is read from the environment by the grader and resolved to base64.
export interface JudgeImage {
  base64: string;
  mediaType: string; // e.g. "image/png"
}

// The assembled evidence a judge renders its verdict from — the ONE unit shared by the transport (Judge.judge),
// the prompt builder (buildPrompt), and the zero-cost preview. assembleJudgeInput is its sole constructor from a
// GradeContext, so a preview sees byte-identical input to a real grade.
export interface JudgeInput {
  task: string;
  trace?: TraceEvent[];
  dom?: string;
  screenshotRef?: string; // External ref such as a browser snapshot (model transport uses screenshot)
  screenshot?: JudgeImage; // Image bytes resolved for VLM input
  response?: string; // Final response from the result channel (prompt snapshot output) — the only evidence when the trace has no assistant message
  expected?: string; // the case's reference output (EvalCase.expected) — EXPECTED OUTPUT evidence
  custom?: Record<string, string>; // resolved custom evidence slots (mapping-authored) → the template's {<name>} placeholders
  rubric?: string;
  criteria?: JudgeCriterion[]; // multi-criteria: the verdict must score every listed criterion
  promptTemplate?: string; // custom judging prompt (must carry {verdict_instruction}) — absent: the default template
}

// Model-based judging abstraction (LLM/VLM). The concrete implementation (real model call) is injected.
export interface Judge {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

function mediaTypeFor(path: string): string {
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
}

// Sniff the image media type from the decoded MAGIC BYTES — source-agnostic, so an image is labeled by its actual
// content, not by a ref's extension. This matters because the control-plane artifact resolution (resolveJudgeArtifacts)
// resolves a screenshot into snap.screenshot WITHOUT a media type, so the extension of a `*.png` ref would otherwise
// mislabel a JPEG as image/png to the VLM. Returns undefined on an unrecognized signature → the caller falls back to
// the extension (today's behavior). Raw base64 (no data: prefix), matching the snapshot convention.
function sniffImageMediaType(base64: string): string | undefined {
  const head = Buffer.from(base64.slice(0, 24), "base64"); // ~18 bytes — enough for any magic number below
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "image/png"; // \x89 P N G
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg"; // JPEG SOI
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return "image/gif"; // G I F 8
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && // R
    head[1] === 0x49 && // I
    head[2] === 0x46 && // F
    head[3] === 0x46 && // F
    head[8] === 0x57 && // W
    head[9] === 0x45 && // E
    head[10] === 0x42 && // B
    head[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return undefined;
}

// Resolves the screenshot of an os-use/browser snapshot into VLM input (base64). If embedded base64 exists, use it as-is (no compute +
// works after dispose too — result-scoring path). For os-use, if absent, fall back to reading directly from the compute file (live run path).
// For browser (service-topology: browser-use etc.), the front-door embeds the final page screenshot as base64 → as VLM judge input, like the
// official WebVoyager (GPT-4V). (browser's screenshotRef may be an external storage URL, so the compute fallback is os-use only.)
async function resolveScreenshot(snap: EnvSnapshot, compute?: ComputeHandle): Promise<JudgeImage | undefined> {
  if ((snap.kind === "os-use" || snap.kind === "browser") && snap.screenshot) {
    // Prefer the sniffed content type (source-agnostic) over the ref extension — a JPEG resolved into the snapshot
    // must not be sent to the VLM as image/png just because its ref path ends in .png.
    return {
      base64: snap.screenshot,
      mediaType: sniffImageMediaType(snap.screenshot) ?? mediaTypeFor(snap.screenshotRef || ".png"),
    };
  }
  if (snap.kind !== "os-use") return undefined;
  if (!snap.screenshotRef || !compute) return undefined;
  const ref = snap.screenshotRef;
  const r = await compute.exec(`base64 -w0 '${ref.replace(/'/g, "'\\''")}'`);
  const base64 = r.stdout.trim();
  if (r.exitCode !== 0 || !base64) return undefined;
  return { base64, mediaType: sniffImageMediaType(base64) ?? mediaTypeFor(ref) };
}

// Assemble the JudgeInput a judge sees from a finished run's GradeContext + the judge's own knobs. The SOLE
// constructor of JudgeInput — JudgeGrader.grade and the preview/dry-run surfaces all go through it, so a
// preview cannot diverge from a real grade. Screenshot resolution reads embedded base64 (no compute) or, for
// os-use with only a ref, the compute file; in a preview (no compute) an os-use ref simply resolves to absent.
export async function assembleJudgeInput(
  ctx: GradeContext,
  opts: { rubric?: string; criteria?: JudgeCriterion[]; promptTemplate?: string; useScreenshot?: boolean } = {},
): Promise<JudgeInput> {
  const snap = ctx.snapshot;
  const screenshot = opts.useScreenshot ? await resolveScreenshot(snap, ctx.compute) : undefined;
  return {
    task: ctx.case.task,
    trace: ctx.trace,
    ...(snap.kind === "browser" ? { dom: snap.dom } : {}),
    ...(snap.kind === "browser" && opts.useScreenshot && snap.screenshotRef
      ? { screenshotRef: snap.screenshotRef }
      : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(snap.kind === "prompt" && snap.output ? { response: snap.output } : {}),
    ...(ctx.case.expected ? { expected: ctx.case.expected } : {}),
    // Custom evidence slots ride GradeContext.evidence (pulled-trace extraction); fixed slots already ride the
    // snapshot/trace, so only `custom` crosses here.
    ...(ctx.evidence?.custom && Object.keys(ctx.evidence.custom).length > 0 ? { custom: ctx.evidence.custom } : {}),
    ...(opts.rubric ? { rubric: opts.rubric } : {}),
    ...(opts.criteria?.length ? { criteria: opts.criteria } : {}),
    ...(opts.promptTemplate ? { promptTemplate: opts.promptTemplate } : {}),
  };
}

// Merge a case's milestones (dataset-defined intermediate expectations) into the judge's criteria for THIS case —
// each becomes a criterion "milestone:<id>" (→ metric judge:<judge-id>:milestone:<id>), so ONE model call verifies
// every intermediate step against the trace and a failed run localizes WHERE it broke. Shared by JudgeGrader.grade
// and the preview/dry-run surfaces (the preview must stay byte-identical to a real grade).
export function withCaseMilestones(
  criteria: JudgeCriterion[] | undefined,
  evalCase: EvalCase,
): JudgeCriterion[] | undefined {
  const milestones = evalCase.milestones ?? [];
  if (milestones.length === 0) return criteria;
  return [
    ...(criteria ?? []),
    ...milestones.map((m) => ({ id: `milestone:${m.id}`, description: m.description, weight: 1 })),
  ];
}

// LLM/VLM judge grader. When useScreenshot, passes the snapshot's screenshot as vision input (browser=ref, os-use=read from the environment as bytes).
// With criteria it is a multi-metric grader: ONE model call → the overall Score (metric "judge") followed by one Score
// per criterion (metric "judge:<criterion-id>"). The judge runner rewrites the "judge" prefix to "judge:<judge-id>".
// A case's milestones merge in as additional criteria (withCaseMilestones) — per-case, at grade time.
export class JudgeGrader implements Grader {
  readonly id: string;
  constructor(
    private readonly judge: Judge,
    private readonly opts: {
      id?: string;
      rubric?: string;
      useScreenshot?: boolean;
      criteria?: JudgeCriterion[];
      promptTemplate?: string;
    } = {},
  ) {
    this.id = opts.id ?? "judge";
  }

  async grade(ctx: GradeContext): Promise<Score | Score[]> {
    // Per-case: the case's milestones join the judge's own criteria so the ONE verdict call scores them all.
    const criteria = withCaseMilestones(this.opts.criteria, ctx.case) ?? [];
    const input = await assembleJudgeInput(ctx, {
      ...(this.opts.rubric ? { rubric: this.opts.rubric } : {}),
      ...(criteria.length ? { criteria } : {}),
      ...(this.opts.promptTemplate ? { promptTemplate: this.opts.promptTemplate } : {}),
      ...(this.opts.useScreenshot ? { useScreenshot: true } : {}),
    });
    const verdict = await this.judge.judge(input);
    const overall: Score = {
      graderId: this.id,
      metric: "judge",
      value: verdict.score,
      pass: verdict.pass,
      detail: verdict.reason,
    };
    if (criteria.length === 0) return overall;
    const perCriterion = criteria.map((c): Score => {
      const v = verdict.criteria?.[c.id];
      // A Judge impl that ignores criteria (non-modelJudge) yields a visible skip, not a silent drop (pass undefined).
      if (!v) {
        return {
          graderId: this.id,
          metric: `judge:${c.id}`,
          value: 0,
          detail: "skipped: criterion missing from the verdict",
        };
      }
      return { graderId: this.id, metric: `judge:${c.id}`, value: v.score, pass: v.pass, detail: v.reason };
    });
    return [overall, ...perCriterion];
  }
}
