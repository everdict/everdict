import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  BadRequestError,
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecOpts,
  type ExecResult,
  InternalError,
} from "@assay/core";

const pexecFile = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// 이미지로 띄운 docker 컨테이너를 compute 로 — 케이스를 자기 env 이미지(예: SWE-bench 공식 prebuilt = repo+deps 동봉)
// 안에서 실행한다. 에이전트를 이미지에 굽지 않고 "환경 컨테이너"에서 명령을 돌린다(공식 SWE-bench 평가 방식).
class DockerComputeHandle implements ComputeHandle {
  constructor(private readonly cid: string) {}

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const args = ["exec"];
    if (opts?.cwd) args.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts?.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(this.cid, "sh", "-c", cmd);
    try {
      const { stdout, stderr } = await pexecFile("docker", args, {
        timeout: (opts?.timeoutSec ?? 600) * 1000,
        maxBuffer: MAX_BUFFER,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      // docker exec 는 컨테이너 명령의 종료코드를 그대로 전파 → 0이 아니면 "명령 실패"(예외 아님).
      if (typeof e.code === "number" || e.stdout !== undefined || e.stderr !== undefined) {
        return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
      throw new InternalError("COMPUTE_EXEC_FAILED", { cmd }, e.message);
    }
  }

  // 컨테이너 안 파일 쓰기 — stdin 으로 전달(임의 크기/이스케이프 안전). 부모 디렉터리 생성.
  async writeFile(path: string, data: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        "docker",
        ["exec", "-i", this.cid, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let stderr = "";
      p.stderr.on("data", (d) => {
        stderr += String(d);
      });
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new InternalError("COMPUTE_EXEC_FAILED", { path }, stderr)),
      );
      p.stdin.end(data);
    });
  }

  async readFile(path: string): Promise<string> {
    const { stdout } = await pexecFile("docker", ["exec", this.cid, "cat", path], { maxBuffer: MAX_BUFFER });
    return stdout;
  }

  async dispose(): Promise<void> {
    await pexecFile("docker", ["rm", "-f", this.cid]).catch(() => {});
  }
}

// env 이미지로 컨테이너를 띄우는 Driver. 격리는 docker(컨테이너) — Backend(Nomad/K8s)의 강격리와 별개의 로컬/단순 실행용.
export class DockerDriver implements Driver {
  readonly id = "docker";
  // 컨테이너를 살려두는 keep-alive(이미지 ENTRYPOINT/CMD 무시). 그 안에서 docker exec 로 명령을 돌린다.
  constructor(private readonly opts: { keepAlive?: string } = {}) {}

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    if (!spec.image) throw new BadRequestError("BAD_REQUEST", undefined, "DockerDriver 는 spec.image 가 필요합니다.");
    const keep = this.opts.keepAlive ?? "infinity";
    const { stdout } = await pexecFile("docker", ["run", "-d", "--entrypoint", "sleep", spec.image, keep], {
      maxBuffer: MAX_BUFFER,
    }).catch((err) => {
      const e = err as { stderr?: string; message?: string };
      throw new InternalError("DRIVER_PROVISION_FAILED", { image: spec.image }, e.stderr || e.message);
    });
    return new DockerComputeHandle(stdout.trim());
  }
}
