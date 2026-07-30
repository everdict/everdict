import { spawn } from "node:child_process";

// Forward handle from the host (control plane) to the cluster — owns the port-forward process lifetime.
export interface PortForward {
  localPort: number;
  stop(): Promise<void>;
}

// kubectl abstraction (mockable in tests; the K8s counterpart of the NomadHttp pattern).
export interface Kubectl {
  apply(manifests: unknown[]): Promise<void>; // kubectl apply -f - (List)
  ensureNamespace(ns: string, labels?: Record<string, string>): Promise<void>;
  rolloutStatus(deployment: string, ns: string, timeoutSec?: number): Promise<void>;
  portForward(target: string, ns: string, remotePort: number): Promise<PortForward>; // target e.g. svc/x
  deleteResources(targets: string[], ns: string): Promise<void>; // target e.g. deployment/x, svc/x
  deleteNamespace(ns: string): Promise<void>;
  // Run a command inside a pod (for store admin DDL/ACL). Resolve the pod name via a selector → exec.
  exec(pod: string, ns: string, command: string[], stdin?: string): Promise<string>;
  podFor(selector: string, ns: string): Promise<string>; // label selector (e.g. app=x) → first pod name
  // Live pod status roster for a label selector (topology observability) — phase/readiness/restarts/reason/node.
  // Optional + best-effort: a runtime without it simply reports the topology as not inspectable; undefined = the
  // query itself failed.
  podStatuses?(
    selector: string,
    ns: string,
  ): Promise<
    | Array<{ name: string; phase?: string; ready?: boolean; restarts?: number; reason?: string; node?: string }>
    | undefined
  >;
  // Current log tail of a target (pod or deployment/x) — the service-level log read. Optional + best-effort.
  logs?(target: string, ns: string, tailLines?: number): Promise<string | undefined>;
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

// Real kubectl implementation driven by a kind/kubeconfig context.
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
    async ensureNamespace(ns, labels) {
      await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: ns, labels } }]);
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
      // `port-forward target :<remotePort>` → kubectl auto-picks a local port and reports it on stdout.
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
    async podStatuses(selector, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "get", "pods", "-l", selector, "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          metadata?: { name?: string };
          spec?: { nodeName?: string };
          status?: {
            phase?: string;
            containerStatuses?: Array<{
              ready?: boolean;
              restartCount?: number;
              state?: { waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number } };
              lastState?: { terminated?: { reason?: string; exitCode?: number } };
            }>;
          };
        }>;
        return items
          .filter((p) => p.metadata?.name)
          .map((p) => {
            const cs = p.status?.containerStatuses?.[0];
            const terminated = cs?.state?.terminated ?? cs?.lastState?.terminated;
            // A bare exit 137 is the OOM killer's signature — surface it as OOMKilled like the eval-job path does.
            const reason =
              terminated?.reason ??
              (terminated?.exitCode === 137 ? "OOMKilled" : undefined) ??
              cs?.state?.waiting?.reason;
            return {
              name: p.metadata?.name as string,
              ...(p.status?.phase ? { phase: p.status.phase } : {}),
              ...(cs?.ready !== undefined ? { ready: cs.ready } : {}),
              ...(cs?.restartCount !== undefined ? { restarts: cs.restartCount } : {}),
              ...(reason ? { reason } : {}),
              ...(p.spec?.nodeName ? { node: p.spec.nodeName } : {}),
            };
          });
      } catch {
        return undefined;
      }
    },
    async logs(target, ns, tailLines = 400) {
      const res = await run(bin, [...ctx, "-n", ns, "logs", target, `--tail=${tailLines}`]);
      return res.code === 0 ? res.stdout : undefined;
    },
  };
}
