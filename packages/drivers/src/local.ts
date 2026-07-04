import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecOpts,
  type ExecResult,
  InternalError,
} from "@assay/core";

const pexec = promisify(exec);
const MAX_BUFFER = 64 * 1024 * 1024;

// 로컬 호스트(임시 디렉터리 + child_process)에서 도는 개발용 Driver.
// 격리는 약하다(호스트 공유) — 개발/테스트 및 에이전트 내부용. 실제 격리는 Backend(Nomad/K8s/Windows)가 담당.
class LocalComputeHandle implements ComputeHandle {
  constructor(private readonly root: string) {}

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? join(this.root, opts.cwd) : this.root;
    try {
      // 샌드박스 안의 cwd 는 요청 시 생성 — 환경이 디렉터리를 만들지 않는 케이스(prompt QA 등)에서
      // 하니스 기본 cwd("work") 부재로 spawn 이 조용히 죽는 문제를 원천 차단한다.
      await mkdir(cwd, { recursive: true });
      const { stdout, stderr } = await pexec(cmd, {
        cwd,
        env: { ...process.env, ...opts?.env },
        timeout: (opts?.timeoutSec ?? 600) * 1000,
        maxBuffer: MAX_BUFFER,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      // child_process는 0이 아닌 종료코드에 reject한다 — 이는 "명령 실패"이지 예외가 아니다.
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      if (typeof e.code === "number" || e.stdout !== undefined || e.stderr !== undefined) {
        return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
      throw new InternalError("COMPUTE_EXEC_FAILED", { cmd }, e.message);
    }
  }

  async writeFile(path: string, data: string): Promise<void> {
    const full = join(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async readFile(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf8");
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export class LocalDriver implements Driver {
  readonly id = "local";

  async provision(_spec: ComputeSpec): Promise<ComputeHandle> {
    const root = await mkdtemp(join(tmpdir(), "assay-"));
    return new LocalComputeHandle(root);
  }
}
