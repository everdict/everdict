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
// 격리는 약하다(호스트 공유) — 빠른 개발/테스트용. 프로덕션 격리는 E2BLinuxDriver/Pool Driver.
class LocalComputeHandle implements ComputeHandle {
  constructor(private readonly root: string) {}

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? join(this.root, opts.cwd) : this.root;
    try {
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
