import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UpstreamError } from "@assay/core";

const execFileAsync = promisify(execFile);

// DockerTopologyRuntime 가 쓰는 얇은 docker CLI 추상화 — kubectl.ts(Kubectl)·nomad exec 와 같은 주입형 패턴.
// 단위 테스트는 가짜 Docker 를 주입(데몬 불필요). 기본 구현은 execFile("docker", …).
export interface DockerRunSpec {
  name: string; // 컨테이너 이름(호스트 전역 유일)
  image: string;
  network: string;
  alias?: string; // --network-alias — 네트워크 내부에서 서비스/스토어가 이 이름으로 서로 도달
  env?: Record<string, string>;
  volumes?: string[]; // -v 마운트 스펙(named volume / bind mount). 예: "vol:/data", "/host:/container:ro"
  publish?: number; // 이 컨테이너 포트를 임의 호스트 포트로 게시(-p <port>) → hostPort 로 발견
  cpus?: number; // --cpus (코어, 소수 가능). ServiceResources.cpu/1000.
  memoryMb?: number; // --memory (MB). ServiceResources.memoryMb.
  args?: string[]; // 이미지 뒤 커맨드/인자(예: minio "server /data", chrome 플래그)
}

// docker run 인자 조립(순수) — 결정적 테스트 대상.
export function dockerRunArgs(s: DockerRunSpec): string[] {
  const args = ["run", "-d", "--name", s.name, "--network", s.network];
  if (s.alias) args.push("--network-alias", s.alias);
  for (const [k, v] of Object.entries(s.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const v of s.volumes ?? []) args.push("-v", v); // named volume / bind mount
  if (s.publish !== undefined) args.push("-p", String(s.publish)); // 호스트 포트 미지정 → 임의 포트 게시
  if (s.cpus !== undefined) args.push("--cpus", String(s.cpus)); // 리소스 요청(코어)
  if (s.memoryMb !== undefined) args.push("--memory", `${s.memoryMb}m`); // 리소스 요청(MB)
  args.push(s.image);
  if (s.args) args.push(...s.args);
  return args;
}

// "docker port <c> 9222" 출력("0.0.0.0:49153\n[::]:49153")에서 호스트 포트를 뽑는다.
export function parseHostPort(out: string): number {
  const m = out.match(/:(\d+)\s*$/m);
  const port = m ? Number(m[1]) : Number.NaN;
  if (!Number.isInteger(port)) {
    throw new UpstreamError("UPSTREAM_ERROR", { out }, "docker port 출력에서 호스트 포트를 찾지 못했습니다.");
  }
  return port;
}

export interface Docker {
  ensureNetwork(name: string): Promise<void>;
  run(spec: DockerRunSpec): Promise<string>; // 컨테이너 id
  hostPort(container: string, containerPort: number): Promise<number>; // 게시된 호스트 포트 발견
  exec(container: string, cmd: string[]): Promise<void>;
  rm(containers: string[]): Promise<void>; // best-effort 강제 제거
  removeNetwork(name: string): Promise<void>;
}

// 기본 구현 — execFile("docker", …). 데몬 미기동/권한없음은 execFile 가 reject → 런타임이 UpstreamError 로 매핑.
export function dockerCli(bin = "docker"): Docker {
  const sh = (args: string[]) => execFileAsync(bin, args);
  return {
    async ensureNetwork(name) {
      try {
        await sh(["network", "inspect", name]);
      } catch {
        await sh(["network", "create", name]);
      }
    },
    async run(spec) {
      const { stdout } = await sh(dockerRunArgs(spec));
      return stdout.trim();
    },
    async hostPort(container, containerPort) {
      const { stdout } = await sh(["port", container, String(containerPort)]);
      return parseHostPort(stdout);
    },
    async exec(container, cmd) {
      await sh(["exec", container, ...cmd]);
    },
    async rm(containers) {
      if (containers.length > 0) await sh(["rm", "-f", ...containers]).catch(() => {});
    },
    async removeNetwork(name) {
      await sh(["network", "rm", name]).catch(() => {});
    },
  };
}
