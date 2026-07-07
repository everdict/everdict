import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BadRequestError,
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecOpts,
  type ExecResult,
  InternalError,
  type RegistryAuth,
  dockerAuthConfigJson,
  imageUsesRegistryHost,
} from "@everdict/core";

const pexecFile = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// 이미지로 띄운 docker 컨테이너를 compute 로 — 케이스를 자기 env 이미지(예: SWE-bench 공식 prebuilt = repo+deps 동봉)
// 안에서 실행한다. 에이전트를 이미지에 굽지 않고 "환경 컨테이너"에서 명령을 돌린다(공식 SWE-bench 평가 방식).
// 상대 경로(cwd/path)는 base(기본 /everdict) 하위로, 절대 경로는 그대로 — RepoEnvironment 의 "work" 와 SWE-bench 의
// "/testbed" 둘 다 자연히 동작.
class DockerComputeHandle implements ComputeHandle {
  constructor(
    private readonly cid: string,
    private readonly base: string,
  ) {}

  private resolve(p: string): string {
    return p.startsWith("/") ? p : `${this.base}/${p}`;
  }

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const args = ["exec", "-w", opts?.cwd ? this.resolve(opts.cwd) : this.base];
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
    const full = this.resolve(path);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        "docker",
        ["exec", "-i", this.cid, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", full],
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
    const { stdout } = await pexecFile("docker", ["exec", this.cid, "cat", this.resolve(path)], {
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  }

  async dispose(): Promise<void> {
    await pexecFile("docker", ["rm", "-f", this.cid]).catch(() => {});
  }
}

// 호스트 자원을 컨테이너에 마운트(예: self-hosted 러너의 codex 로그인 디렉터리 → 컨테이너 안 codex 가 머신 로그인 사용).
// source=호스트 경로(러너가 결정, 임의 데이터가 아니라 러너 opt-in), target=컨테이너 경로. readOnly 기본 false.
export interface DriverMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

// 워크스페이스 레지스트리 이미지의 인증 pull — 자격증명을 임시 DOCKER_CONFIG 디렉터리에만 쓰고(0600) 끝나면
// 지운다(호스트 ~/.docker/config.json 불가침, everdict image push 와 동일 규율). 이미지 호스트가 auth.host 와
// 일치할 때만 호출된다. pull 이 끝나면 이어지는 docker run 은 로컬 이미지를 쓴다.
export async function pullWithRegistryAuth(image: string, auth: RegistryAuth): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), "everdict-pull-"));
  try {
    await writeFile(join(configDir, "config.json"), dockerAuthConfigJson(auth), { mode: 0o600 });
    await pexecFile("docker", ["--config", configDir, "pull", image], { maxBuffer: MAX_BUFFER }).catch((err) => {
      const e = err as { stderr?: string; message?: string };
      throw new InternalError("DRIVER_PROVISION_FAILED", { image, registry: auth.host }, e.stderr || e.message);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

// env 이미지로 컨테이너를 띄우는 Driver. 격리는 docker(컨테이너) — Backend(Nomad/K8s)의 강격리와 별개의 로컬/단순 실행용.
export class DockerDriver implements Driver {
  readonly id = "docker";
  private readonly base: string;
  private readonly mounts: DriverMount[];
  // defaultImage: 케이스가 image 를 안 실으면 쓸 기본 이미지. keepAlive: 컨테이너 유지 sleep 인자. base: 상대경로 작업루트.
  // mounts: 호스트→컨테이너 바인드 마운트(러너가 주입 — 예: codex 로그인). registryAuth: 워크스페이스 레지스트리
  // pull 자격증명(transient, AgentJob.registryAuth) — 이미지 호스트가 일치하면 인증 pre-pull 후 run.
  // 설계: docs/architecture/portable-harness-runtime.md · workspace-image-registry.md.
  constructor(
    private readonly opts: {
      defaultImage?: string;
      keepAlive?: string;
      base?: string;
      mounts?: DriverMount[];
      registryAuth?: RegistryAuth;
    } = {},
  ) {
    this.base = opts.base ?? "/everdict";
    this.mounts = opts.mounts ?? [];
  }

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    const image = spec.image ?? this.opts.defaultImage;
    if (!image) {
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "DockerDriver 는 spec.image 또는 defaultImage 가 필요합니다.",
      );
    }
    // 워크스페이스 레지스트리 이미지면 인증 pre-pull(임시 DOCKER_CONFIG) — 호스트 데몬에 로그인 흔적을 남기지 않는다.
    const auth = this.opts.registryAuth;
    if (auth && imageUsesRegistryHost(image, auth.host)) await pullWithRegistryAuth(image, auth);
    const keep = this.opts.keepAlive ?? "infinity";
    // 바인드 마운트 인자(-v source:target[:ro]) — 이미지 앞에 온다.
    const mountArgs = this.mounts.flatMap((m) => ["-v", `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`]);
    // 이미지 ENTRYPOINT/CMD 무시 + base 디렉터리 보장 + keep-alive. 그 안에서 docker exec 로 명령 실행.
    const { stdout } = await pexecFile(
      "docker",
      ["run", "-d", ...mountArgs, "--entrypoint", "sh", image, "-c", `mkdir -p ${this.base} && exec sleep ${keep}`],
      { maxBuffer: MAX_BUFFER },
    ).catch((err) => {
      const e = err as { stderr?: string; message?: string };
      throw new InternalError("DRIVER_PROVISION_FAILED", { image }, e.stderr || e.message);
    });
    return new DockerComputeHandle(stdout.trim(), this.base);
  }
}
