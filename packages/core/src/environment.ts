import { z } from "zod";
import type { ComputeHandle } from "./compute.js";

// v1은 repo만. browser/os-use는 union에 variant를 추가한다(코어 재작성 없음).
export const RepoSnapshotSchema = z.object({
  kind: z.literal("repo"),
  diff: z.string(),
  changedFiles: z.array(z.string()),
  headSha: z.string(),
});
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;

// 브라우저 타깃 환경의 결과 관측 (DOM/스크린샷/URL). screenshotRef = MinIO object ref.
export const BrowserSnapshotSchema = z.object({
  kind: z.literal("browser"),
  url: z.string(),
  dom: z.string(),
  screenshotRef: z.string().optional(),
  // 최종 페이지 스크린샷 PNG 를 base64 로 동봉(os-use 와 동형) — VLM judge(useScreenshot) 입력 + 웹 인라인 표시.
  // 공식 WebVoyager 가 GPT-4V 로 스크린샷을 판정하는 방식을 재현. 없으면(미동봉) 텍스트 judge 로 폴백.
  screenshot: z.string().optional(),
  console: z.array(z.string()).default([]),
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;

// 환경 없는 QA(프롬프트→답). 결과 세계가 없으므로 스냅샷은 최소(채점은 trace 의 답을 본다 — answer-match/judge).
export const PromptSnapshotSchema = z.object({
  kind: z.literal("prompt"),
  output: z.string().default(""), // 선택: 에이전트 최종 답(있으면). 1차 신호는 trace.
});
export type PromptSnapshot = z.infer<typeof PromptSnapshotSchema>;

// 데스크탑(OS) 컴퓨터-유즈 결과 관측 — 화면 스크린샷 + 창 목록(OSWorld 류, 데스크탑 앱 자동화). VLM judge 의 입력.
export const OsUseSnapshotSchema = z.object({
  kind: z.literal("os-use"),
  screenshotRef: z.string().default(""), // 캡처한 스크린샷 경로/ref (이미지 컴퓨트 안)
  // 스크린샷 PNG 를 base64 로 동봉(컴퓨트는 dispose 되므로 결과 밖으로 들고 나오는 운반체). 표시(웹 <img>)+VLM judge 입력.
  // dev 경로: 결과 레코드에 인라인. 스케일 시 object storage(MinIO)로 오프로드 + presigned URL 로 치환(screenshotRef).
  screenshot: z.string().default(""), // base64 PNG (없으면 빈 문자열)
  windows: z.array(z.string()).default([]), // 보이는 창 제목들(있으면)
});
export type OsUseSnapshot = z.infer<typeof OsUseSnapshotSchema>;

export const EnvSnapshotSchema = z.discriminatedUnion("kind", [
  RepoSnapshotSchema,
  BrowserSnapshotSchema,
  PromptSnapshotSchema,
  OsUseSnapshotSchema,
]);
export type EnvSnapshot = z.infer<typeof EnvSnapshotSchema>;

// repo 시드 출처: 원격 git / 인라인 파일 맵(픽스처) / 이미지-내 경로(컨테이너에 이미 체크아웃된 repo, 예: SWE-bench /testbed).
// path: clone 하지 않고 이미지에 있는 repo 를 작업 디렉터리로 쓴다(deps 도 이미지에 동봉) — 코딩 에이전트가 그 repo 에 직접 작업.
export const RepoSourceSchema = z.union([
  // 원격 git: public 이면 그대로, 비공개면 connectionId 로 워크스페이스 외부 계정 연결(Connected accounts)을 참조 —
  // 컨트롤플레인이 dispatch 시 그 토큰을 resolve 해 잡(AgentJob.repoToken)에 transient 로 실어 인증 clone(토큰은 케이스에 저장 안 됨).
  z.object({ git: z.string().url(), ref: z.string(), connectionId: z.string().optional() }),
  z.object({ files: z.record(z.string()) }),
  z.object({ path: z.string() }),
]);
export type RepoSource = z.infer<typeof RepoSourceSchema>;

export const EnvSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo"),
    source: RepoSourceSchema,
    setup: z.array(z.string()).optional(),
  }),
  // 타깃 환경(II): 브라우저. 케이스 시드 = 시작 URL. 실제 인스턴스는 TopologyRuntime 이 per-case 로 띄운다.
  z.object({
    kind: z.literal("browser"),
    startUrl: z.string().optional(),
  }),
  // 환경 없는 QA(프롬프트→답). repo/browser 같은 무대가 없다 — gsm8k/GAIA 류. 선택적 context 를 task 에 더한다.
  z.object({
    kind: z.literal("prompt"),
    context: z.string().optional(),
  }),
  // 타깃 환경: 데스크탑(OS). 에이전트가 화면을 보고 마우스/키보드로 GUI 앱을 조작(OSWorld/컴퓨터-유즈, 예: hermes-desktop).
  // 데스크탑 컴퓨트 이미지(Xvfb+앱)에서 동작 — setup 으로 디스플레이/앱 기동, screenshotCmd 로 관측.
  z.object({
    kind: z.literal("os-use"),
    display: z.string().optional(), // X DISPLAY (기본 ":99")
    setup: z.array(z.string()).optional(), // 디스플레이/윈도우매니저/앱 기동 명령(Xvfb, wm, 데스크탑 앱)
    screenshotCmd: z.string().optional(), // 스크린샷 캡처 명령(기본 scrot). 산출물 경로 = screenshotPath
    screenshotPath: z.string().optional(), // 스크린샷 저장 경로(기본 /tmp/assay-screen.png)
  }),
]);
export type EnvSpec = z.infer<typeof EnvSpecSchema>;

// 행동 무대. seed=알려진 초기상태로, snapshot=결과 세계 포착.
export interface Environment<S extends EnvSnapshot = EnvSnapshot> {
  readonly kind: S["kind"];
  seed(compute: ComputeHandle, spec: EnvSpec): Promise<void>;
  snapshot(compute: ComputeHandle): Promise<S>;
}
