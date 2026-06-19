import { spawn } from "node:child_process";
import { RESULT_SENTINEL } from "@assay/agent";
import { type AgentJob, type CaseResult, CaseResultSchema, UpstreamError, assertHardenedIsolation } from "@assay/core";
import type { Backend, BackendCapacity } from "./backend.js";
import type { SecretProvider } from "./secrets.js";
import type { TrustZonePolicy } from "./trust-zone.js";

// --- kubectl 추상화 (테스트에서 모킹 가능; NomadHttp 의 K8s 버전) ---
export interface K8sApi {
  ensureNamespace(ns: string): Promise<void>;
  applyJob(manifest: unknown, ns: string): Promise<void>; // kubectl -n ns apply -f -
  jobStatus(name: string, ns: string): Promise<{ succeeded: number; failed: number }>;
  podLogs(name: string, ns: string): Promise<string>; // job/<name> 의 stdout
  deleteJob(name: string, ns: string): Promise<void>;
  countActiveJobs(): Promise<number | undefined>; // 용량 프로브(전 네임스페이스의 app=assay 진행중 잡)
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
// 외부 클러스터를 bearer 토큰으로 인증하려면 context 대신 server+token 을 준다(kubectl --server/--token).
export function kubectlApi(opts: { context?: string; bin?: string; server?: string; token?: string } = {}): K8sApi {
  const bin = opts.bin ?? "kubectl";
  const ctx = [
    ...(opts.context ? ["--context", opts.context] : []),
    ...(opts.server ? ["--server", opts.server] : []),
    ...(opts.token ? ["--token", opts.token] : []),
  ];
  return {
    async ensureNamespace(ns) {
      const res = await run(
        bin,
        [...ctx, "apply", "-f", "-"],
        JSON.stringify({ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } }),
      );
      if (res.code !== 0) throw new Error(`ensureNamespace ${ns}: ${res.stderr || res.stdout}`);
    },
    async applyJob(manifest, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "apply", "-f", "-"], JSON.stringify(manifest));
      if (res.code !== 0) throw new Error(`apply job: ${res.stderr || res.stdout}`);
    },
    async jobStatus(name, ns) {
      const res = await run(bin, [
        ...ctx,
        "-n",
        ns,
        "get",
        "job",
        name,
        "-o",
        "jsonpath={.status.succeeded} {.status.failed}",
      ]);
      if (res.code !== 0) return { succeeded: 0, failed: 0 };
      const [su, fa] = res.stdout.trim().split(/\s+/);
      return { succeeded: Number(su) || 0, failed: Number(fa) || 0 };
    },
    async podLogs(name, ns) {
      const res = await run(bin, [...ctx, "-n", ns, "logs", `job/${name}`, "--tail=-1"]);
      if (res.code !== 0)
        throw new UpstreamError("UPSTREAM_ERROR", { name }, `로그 조회 실패: ${res.stderr || res.stdout}`);
      return res.stdout;
    },
    async deleteJob(name, ns) {
      await run(bin, [
        ...ctx,
        "-n",
        ns,
        "delete",
        "job",
        name,
        "--ignore-not-found",
        "--cascade=background",
        "--wait=false",
      ]);
    },
    async countActiveJobs() {
      const res = await run(bin, [...ctx, "get", "jobs", "-A", "-l", "app=assay", "-o", "json"]);
      if (res.code !== 0) return undefined;
      try {
        const items = (JSON.parse(res.stdout).items ?? []) as Array<{
          status?: { succeeded?: number; failed?: number };
        }>;
        return items.filter((j) => !j.status?.succeeded && !j.status?.failed).length;
      } catch {
        return undefined;
      }
    },
  };
}

export interface K8sBackendOptions {
  image: string; // 러너 에이전트 이미지
  api?: K8sApi;
  context?: string; // kubeconfig 컨텍스트(예: kind-assay)
  server?: string; // 외부 API 서버 URL(context 대신 bearer 인증할 때)
  apiToken?: string; // K8s API bearer 토큰(kubectl --token) — 컨트롤플레인↔K8s API 인증. alloc env 와 무관.
  secretEnv?: Record<string, string>; // 잡에 주입할 인증(secrets 없을 때 기본)
  secrets?: SecretProvider; // 테넌트별 시크릿 스코핑
  namespace?: string; // 기본 네임스페이스(테넌트 존이 없을 때)
  runtimeClass?: string; // 명시 runtimeClassName(gVisor=gvisor 등). trustZones 가 우선.
  trustZones?: TrustZonePolicy; // 테넌트별 격리 — 네임스페이스 + runtimeClassName 강제
  imagePullPolicy?: string; // 기본 IfNotPresent (kind 로드 이미지)
  hostNetwork?: boolean; // 파드가 노드 네트워크 공유 — 호스트 서비스(예: dev LiteLLM) 접근용. ⚠️ 격리 약화: dev 전용.
  ttlSecondsAfterFinished?: number; // 잡 자동 정리(기본 300)
  pollIntervalMs?: number;
  maxPolls?: number;
  maxConcurrent?: number | (() => number);
}

// 하드닝 격리 런타임(Nomad 표기) → K8s RuntimeClass 이름 매핑.
const RUNTIME_CLASS: Record<string, string> = { runsc: "gvisor", kata: "kata", "kata-runtime": "kata" };

// DNS-1123 잡 이름(소문자/숫자/하이픈, ≤63).
export function k8sJobName(job: AgentJob): string {
  const slug = job.evalCase.id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `assay-${slug || "case"}`;
}

// AgentJob → K8s batch Job. 페이로드는 ASSAY_AGENT_JOB(base64) env. 격리는 runtimeClassName.
export function buildK8sJob(
  job: AgentJob,
  opts: K8sBackendOptions,
  name: string,
  ns: string,
  runtimeClassName?: string,
): Record<string, unknown> {
  const env: Record<string, string> = {
    ASSAY_AGENT_JOB: Buffer.from(JSON.stringify(job)).toString("base64"),
    ...opts.secretEnv,
  };
  const tenant = job.tenant ?? "default";
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: ns, labels: { app: "assay", "assay.dev/tenant": tenant } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished ?? 300,
      template: {
        metadata: { labels: { app: "assay", "assay.dev/tenant": tenant } },
        spec: {
          restartPolicy: "Never",
          ...(runtimeClassName ? { runtimeClassName } : {}),
          ...(opts.hostNetwork ? { hostNetwork: true } : {}),
          containers: [
            {
              name: "agent",
              image: opts.image,
              imagePullPolicy: opts.imagePullPolicy ?? "IfNotPresent",
              env: Object.entries(env).map(([n, value]) => ({ name: n, value })),
            },
          ],
        },
      },
    },
  };
}

function parseResult(stdout: string): CaseResult {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) throw new UpstreamError("UPSTREAM_ERROR", undefined, "에이전트 결과(sentinel)를 찾지 못했습니다.");
  const line = stdout.slice(idx + RESULT_SENTINEL.length).split("\n")[0] ?? "";
  return CaseResultSchema.parse(JSON.parse(line));
}

// 모델 B: 러너 에이전트를 K8s Job 으로 띄우고 완료를 폴링한 뒤 파드 로그의 sentinel 에서 CaseResult 파싱.
// 격리는 네임스페이스(테넌트별) + runtimeClassName(gVisor/kata). NomadBackend 의 K8s 짝.
export class K8sBackend implements Backend {
  readonly id = "k8s";
  private readonly api: K8sApi;

  constructor(private readonly opts: K8sBackendOptions) {
    this.api =
      opts.api ??
      kubectlApi({
        ...(opts.context ? { context: opts.context } : {}),
        ...(opts.server ? { server: opts.server } : {}),
        ...(opts.apiToken ? { token: opts.apiToken } : {}),
      });
  }

  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    const total = (typeof mc === "function" ? mc() : mc) ?? 20;
    const used = await this.api.countActiveJobs();
    return { total, used: used ?? 0 };
  }

  // 테넌트 존/시크릿을 잡마다 적용·강제: untrusted 는 강격리 필수, 전용 네임스페이스, 그 테넌트 키만 주입.
  private async resolve(
    job: AgentJob,
  ): Promise<{ ns: string; runtimeClassName?: string; secretEnv?: Record<string, string> }> {
    const tenant = job.tenant ?? "default";
    const zone = this.opts.trustZones?.resolve(tenant);
    const secretEnv = this.opts.secrets ? await this.opts.secrets.secretsFor(tenant) : this.opts.secretEnv;
    if (!zone) return { ns: this.opts.namespace ?? "default", runtimeClassName: this.opts.runtimeClass, secretEnv };
    assertHardenedIsolation(zone);
    // 하드닝 런타임만 RuntimeClass 로 매핑(runsc→gvisor/kata). runc/none(trusted dev)은 클러스터 기본 런타임.
    const runtimeClassName = this.opts.runtimeClass ?? RUNTIME_CLASS[zone.isolationRuntime];
    return { ns: zone.namespace ?? this.opts.namespace ?? "default", runtimeClassName, secretEnv };
  }

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const { ns, runtimeClassName, secretEnv } = await this.resolve(job);
    const name = k8sJobName(job);
    await this.api.ensureNamespace(ns);
    await this.api.applyJob(buildK8sJob(job, { ...this.opts, secretEnv }, name, ns, runtimeClassName), ns);
    try {
      await this.waitForJob(name, ns);
      return parseResult(await this.api.podLogs(name, ns));
    } finally {
      await this.api.deleteJob(name, ns);
    }
  }

  private async waitForJob(name: string, ns: string): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    for (let i = 0; i < maxPolls; i++) {
      const { succeeded, failed } = await this.api.jobStatus(name, ns);
      if (succeeded > 0) return;
      if (failed > 0) throw new UpstreamError("UPSTREAM_ERROR", { name, ns }, "K8s Job 실패");
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { name, ns }, "K8s Job 완료 대기 시간초과");
  }
}
