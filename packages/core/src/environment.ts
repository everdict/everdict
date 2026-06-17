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

export const EnvSnapshotSchema = z.discriminatedUnion("kind", [RepoSnapshotSchema]);
export type EnvSnapshot = z.infer<typeof EnvSnapshotSchema>;

// repo 시드 출처: 원격 git, 또는 인라인 파일 맵(픽스처/로컬 평가용).
export const RepoSourceSchema = z.union([
  z.object({ git: z.string().url(), ref: z.string() }),
  z.object({ files: z.record(z.string()) }),
]);
export type RepoSource = z.infer<typeof RepoSourceSchema>;

export const EnvSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo"),
    source: RepoSourceSchema,
    setup: z.array(z.string()).optional(),
  }),
]);
export type EnvSpec = z.infer<typeof EnvSpecSchema>;

// 행동 무대. seed=알려진 초기상태로, snapshot=결과 세계 포착.
export interface Environment<S extends EnvSnapshot = EnvSnapshot> {
  readonly kind: S["kind"];
  seed(compute: ComputeHandle, spec: EnvSpec): Promise<void>;
  snapshot(compute: ComputeHandle): Promise<S>;
}
