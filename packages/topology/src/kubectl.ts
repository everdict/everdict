import { spawn } from "node:child_process";

// 호스트(컨트롤플레인)에서 클러스터로 가는 포워드 핸들 — port-forward 프로세스 수명을 잡는다.
export interface PortForward {
  localPort: number;
  stop(): Promise<void>;
}

// kubectl 추상화 (테스트에서 모킹 가능; NomadHttp 패턴의 K8s 버전).
export interface Kubectl {
  apply(manifests: unknown[]): Promise<void>; // kubectl apply -f - (List)
  ensureNamespace(ns: string): Promise<void>;
  rolloutStatus(deployment: string, ns: string, timeoutSec?: number): Promise<void>;
  portForward(target: string, ns: string, remotePort: number): Promise<PortForward>; // target 예: svc/x
  deleteResources(targets: string[], ns: string): Promise<void>; // target 예: deployment/x, svc/x
  deleteNamespace(ns: string): Promise<void>;
  // 파드 안에서 명령 실행(스토어 어드민 DDL/ACL 용). selector 로 파드명 해석 → exec.
  exec(pod: string, ns: string, command: string[], stdin?: string): Promise<string>;
  podFor(selector: string, ns: string): Promise<string>; // label selector (예: app=x) → 첫 파드명
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

// kind/kubeconfig 컨텍스트로 동작하는 실 kubectl 구현.
export function kubectlCli(opts: { context?: string; bin?: string } = {}): Kubectl {
  const bin = opts.bin ?? "kubectl";
  const ctx = opts.context ? ["--context", opts.context] : [];

  async function apply(manifests: unknown[]): Promise<void> {
    const list = { apiVersion: "v1", kind: "List", items: manifests };
    const res = await run(bin, [...ctx, "apply", "-f", "-"], JSON.stringify(list));
    if (res.code !== 0) throw new Error(`kubectl apply failed: ${res.stderr || res.stdout}`);
  }

  return {
    apply,
    async ensureNamespace(ns) {
      await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } }]);
    },
    async rolloutStatus(deployment, ns, timeoutSec = 120) {
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "rollout",
        "status",
        `deployment/${deployment}`,
        `--timeout=${timeoutSec}s`,
      ]);
      if (res.code !== 0) throw new Error(`rollout status ${deployment} failed: ${res.stderr || res.stdout}`);
    },
    portForward(target, ns, remotePort) {
      // `port-forward target :<remotePort>` → kubectl 가 로컬 포트를 자동 선택하고 stdout 에 알린다.
      return new Promise<PortForward>((resolve, reject) => {
        const proc = spawn(bin, [...ctx, "-n", ns, "port-forward", target, `:${remotePort}`], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let buf = "";
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`port-forward ${target} timed out`));
        }, 30_000);
        proc.stdout.on("data", (d) => {
          buf += d.toString();
          const m = buf.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
          if (m) {
            clearTimeout(timer);
            const localPort = Number(m[1]);
            resolve({
              localPort,
              stop: () =>
                new Promise<void>((res) => {
                  proc.once("close", () => res());
                  proc.kill();
                }),
            });
          }
        });
        proc.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`port-forward ${target} exited (${code})`));
        });
      });
    },
    async deleteResources(targets, ns) {
      if (targets.length === 0) return;
      await run(bin, [...ctx, "-n", ns, "delete", ...targets, "--ignore-not-found", "--wait=false"]);
    },
    async deleteNamespace(ns) {
      await run(bin, [...ctx, "delete", "namespace", ns, "--ignore-not-found", "--wait=false"]);
    },
    async podFor(selector, ns) {
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "get",
        "pod",
        "-l",
        selector,
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ]);
      if (res.code !== 0 || !res.stdout.trim()) throw new Error(`podFor ${selector} failed: ${res.stderr || "no pod"}`);
      return res.stdout.trim();
    },
    async exec(pod, ns, command, stdin) {
      const args = [...ctx, "-n", ns, "exec", ...(stdin !== undefined ? ["-i"] : []), pod, "--", ...command];
      const res = await run(bin, args, stdin);
      if (res.code !== 0) throw new Error(`exec ${command[0]} in ${pod} failed: ${res.stderr || res.stdout}`);
      return res.stdout;
    },
  };
}
