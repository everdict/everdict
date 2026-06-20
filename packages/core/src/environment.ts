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
  console: z.array(z.string()).default([]),
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;

export const EnvSnapshotSchema = z.discriminatedUnion("kind", [RepoSnapshotSchema, BrowserSnapshotSchema]);
export type EnvSnapshot = z.infer<typeof EnvSnapshotSchema>;

// repo 시드 출처: 원격 git / 인라인 파일 맵(픽스처) / 이미지-내 경로(컨테이너에 이미 체크아웃된 repo, 예: SWE-bench /testbed).
// path: clone 하지 않고 이미지에 있는 repo 를 작업 디렉터리로 쓴다(deps 도 이미지에 동봉) — 코딩 에이전트가 그 repo 에 직접 작업.
export const RepoSourceSchema = z.union([
  z.object({ git: z.string().url(), ref: z.string() }),
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
]);
export type EnvSpec = z.infer<typeof EnvSpecSchema>;

// 행동 무대. seed=알려진 초기상태로, snapshot=결과 세계 포착.
export interface Environment<S extends EnvSnapshot = EnvSnapshot> {
  readonly kind: S["kind"];
  seed(compute: ComputeHandle, spec: EnvSpec): Promise<void>;
  snapshot(compute: ComputeHandle): Promise<S>;
}
