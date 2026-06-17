import { z } from "zod";

export const CapabilitySchema = z.enum(["shell", "browser", "desktop"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ComputeSpecSchema = z.object({
  os: z.literal("linux"), // v1. windows/macos는 Pool Driver에서 확장.
  image: z.string().optional(),
  needs: z.array(CapabilitySchema).default(["shell"]),
  cpu: z.number().optional(),
  memMb: z.number().optional(),
});
export type ComputeSpec = z.infer<typeof ComputeSpecSchema>;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOpts {
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
}

// 격리된 실행 단위. OS-use 단계에서 `computer?: Computer`(screenshot/click/type)로 확장.
export interface ComputeHandle {
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  dispose(): Promise<void>;
}

// 샌드박스 내부의 컴퓨트(in-sandbox compute). 구현: LocalDriver (개발/에이전트 내부).
// 실제 격리/배치는 Backend(Nomad/K8s/Windows)가 담당한다 — Driver 가 아니다.
export interface Driver {
  readonly id: string;
  provision(spec: ComputeSpec): Promise<ComputeHandle>;
}
