import type { ComputeHandle, EnvSnapshot, GradeContext, Grader, Score, TraceEvent } from "@everdict/core";

export interface JudgeVerdict {
  pass: boolean;
  score: number;
  reason: string;
}

// VLM 판정에 넘기는 이미지(스크린샷) 바이트. ref(경로)는 grader 가 환경에서 읽어 base64 로 해석해 채운다.
export interface JudgeImage {
  base64: string;
  mediaType: string; // 예: "image/png"
}

// 모델 기반 판정 추상화 (LLM/VLM). 구체 구현(실모델 호출)은 주입한다.
export interface Judge {
  judge(input: {
    task: string;
    trace?: TraceEvent[];
    dom?: string;
    screenshotRef?: string; // 브라우저 스냅샷 등 외부 ref(모델 전송은 screenshot 사용)
    screenshot?: JudgeImage; // VLM 입력용으로 해석된 이미지 바이트
    rubric?: string;
  }): Promise<JudgeVerdict>;
}

function mediaTypeFor(path: string): string {
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
}

// os-use/browser 스냅샷의 스크린샷을 VLM 입력(base64)으로 해석. 동봉된 base64 가 있으면 그대로 쓴다(컴퓨트 불필요 +
// dispose 후에도 동작 — 결과 채점 경로). os-use 는 없으면 폴백으로 컴퓨트 파일에서 직접 읽는다(라이브 run 경로).
// browser(서비스-토폴로지: browser-use 등)는 front-door 가 최종 페이지 스크린샷을 base64 로 동봉 → 공식 WebVoyager(GPT-4V)
// 처럼 VLM judge 입력으로. (browser 의 screenshotRef 는 외부 스토리지 URL 일 수 있어 컴퓨트 폴백은 os-use 만.)
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

// LLM/VLM judge 그레이더. useScreenshot 이면 스냅샷의 스크린샷을 비전 입력으로 넘긴다(브라우저=ref, os-use=환경에서 읽어 바이트).
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
