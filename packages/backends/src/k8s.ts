import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_SENTINEL } from "@everdict/agent";
import {
  type AgentJob,
  type CaseResult,
  CaseResultSchema,
  UpstreamError,
  assertHardenedIsolation,
  dockerAuthConfigJson,
  imageUsesRegistryHost,
  judgeEnv,
} from "@everdict/core";
import type { Backend, BackendCapacity, ProbeResult } from "./backend.js";
import type { SecretProvider } from "./secrets.js";
import type { TrustZonePolicy } from "./trust-zone.js";

// --- kubectl 추상화 (테스트에서 모킹 가능; NomadHttp 의 K8s 버전) ---
export interface K8sApi {
  ensureNamespace(ns: string): Promise<void>;
  applyJob(manifest: unknown, ns: string): Promise<void>; // kubectl -n ns apply -f -
  jobStatus(name: string, ns: string): Promise<{ succeeded: number; failed: number }>;
  podLogs(name: string, ns: string): Promise<string>; // job/<name> 의 stdout
  deleteJob(name: string, ns: string): Promise<void>;
  countActiveJobs(): Promise<number | undefined>; // 용량 프로브(전 네임스페이스의 app=everdict 진행중 잡)
  serverVersion(): Promise<string>; // 연결 테스트 — API 서버 /version(gitVersion). 도달/인증 실패 시 throw.
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

// kubectl 전역 인증 인자(선택자) — 테스트 가능하게 분리. 우선순위: kubeconfig(파일 경로) > context > server/token.
export function kubectlArgs(opts: {
  context?: string;
  server?: string;
  token?: string;
  kubeconfig?: string;
}): string[] {
  return [
    ...(opts.kubeconfig ? ["--kubeconfig", opts.kubeconfig] : []),
    ...(opts.context ? ["--context", opts.context] : []),
    ...(opts.server ? ["--server", opts.server] : []),
    ...(opts.token ? ["--token", opts.token] : []),
  ];
}

// kind/kubeconfig 컨텍스트로 동작하는 실 kubectl 구현.
// 외부 클러스터: bearer 토큰(context 대신 server+token) 또는 전체 kubeconfig 파일(--kubeconfig)로 인증.
export function kubectlApi(
  opts: { context?: string; bin?: string; server?: string; token?: string; kubeconfig?: string } = {},
): K8sApi {
  const bin = opts.bin ?? "kubectl";
  const ctx = kubectlArgs(opts);
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
      const res = await run(bin, [...ctx, "get", "jobs", "-A", "-l", "app=everdict", "-o", "json"]);
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
    async serverVersion() {
      // get --raw=/version 은 API 서버에 직접 도달 — 미도달/인증실패면 비-제로 종료(throw).
      const res = await run(bin, [...ctx, "get", "--raw=/version"]);
      if (res.code !== 0)
        throw new UpstreamError("UPSTREAM_ERROR", undefined, (res.stderr || res.stdout).trim().slice(0, 300));
      try {
        const v = JSON.parse(res.stdout) as { gitVersion?: string };
        return v.gitVersion ?? res.stdout.trim().slice(0, 200);
      } catch {
        return res.stdout.trim().slice(0, 200);
      }
    },
  };
}

export interface K8sBackendOptions {
  image: string; // 러너 에이전트 이미지
  api?: K8sApi;
  context?: string; // kubeconfig 컨텍스트(예: kind-everdict)
  server?: string; // 외부 API 서버 URL(context 대신 bearer 인증할 때)
  apiToken?: string; // K8s API bearer 토큰(kubectl --token) — 컨트롤플레인↔K8s API 인증. alloc env 와 무관.
  // 전체 kubeconfig YAML(값). 설정되면 디스패치마다 임시파일(0600)에 써서 --kubeconfig 로 인증하고 끝나면 제거.
  // context/server/apiToken 보다 우선. 클러스터 자격증명이라 잡(에이전트) env 로는 절대 들어가지 않는다.
  kubeconfig?: string;
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
  return `everdict-${slug || "case"}`;
}

// imagePullSecrets 가 참조하는 Secret 이름 — 네임스페이스당 하나, apply 가 멱등 upsert 한다(잡 삭제와 무관하게 유지).
export const K8S_REGISTRY_AUTH_SECRET = "everdict-registry-auth";

// 워크스페이스 레지스트리 자격증명(job.registryAuth transient) → dockerconfigjson Secret. case.image 가
// 그 레지스트리 호스트일 때 dispatch 가 Job 과 함께 List 로 apply 한다.
export function k8sRegistryAuthSecret(
  auth: NonNullable<AgentJob["registryAuth"]>,
  ns: string,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: K8S_REGISTRY_AUTH_SECRET, namespace: ns, labels: { app: "everdict" } },
    type: "kubernetes.io/dockerconfigjson",
    data: { ".dockerconfigjson": Buffer.from(dockerAuthConfigJson(auth)).toString("base64") },
  };
}

// AgentJob → K8s batch Job. 페이로드는 EVERDICT_AGENT_JOB(base64) env. 격리는 runtimeClassName.
export function buildK8sJob(
  job: AgentJob,
  opts: K8sBackendOptions,
  name: string,
  ns: string,
  runtimeClassName?: string,
): Record<string, unknown> {
  const env: Record<string, string> = {
    EVERDICT_AGENT_JOB: Buffer.from(JSON.stringify(job)).toString("base64"),
    ...judgeEnv(job.judge), // per-run judge 모델 설정(키는 secretEnv). inline judge grader 가 이 모델로 판정.
    ...opts.secretEnv,
  };
  // per-case 이미지(예: SWE-bench 공식 prebuilt = deps+repo 동봉) 우선, 없으면 기본 에이전트 이미지.
  const image = job.evalCase.image ?? opts.image;
  // 워크스페이스 레지스트리 이미지면 imagePullSecrets(위 Secret 은 dispatch 가 함께 apply) — 호스트 일치 시에만.
  const pullAuth = Boolean(job.registryAuth && imageUsesRegistryHost(image, job.registryAuth.host));
  const tenant = job.tenant ?? "default";
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: ns, labels: { app: "everdict", "everdict.dev/tenant": tenant } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished ?? 300,
      template: {
        metadata: { labels: { app: "everdict", "everdict.dev/tenant": tenant } },
        spec: {
          restartPolicy: "Never",
          ...(runtimeClassName ? { runtimeClassName } : {}),
          ...(opts.hostNetwork ? { hostNetwork: true } : {}),
          ...(pullAuth ? { imagePullSecrets: [{ name: K8S_REGISTRY_AUTH_SECRET }] } : {}),
          containers: [
            {
              name: "agent",
              image,
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

// kubeconfig(YAML 값)를 임시파일로 써서 kubectl --kubeconfig 로 쓸 경로를 돌려준다. 복호화된 클러스터 자격증명이므로
// mode 0600 으로 쓰고, 디스패치가 끝나면 cleanup() 으로 파일+디렉터리를 제거한다(디스크에 오래 남기지 않는다).
export async function materializeKubeconfig(yaml: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "everdict-kcfg-"));
  const path = join(dir, "kubeconfig");
  await writeFile(path, yaml, { mode: 0o600 });
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// 모델 B: 러너 에이전트를 K8s Job 으로 띄우고 완료를 폴링한 뒤 파드 로그의 sentinel 에서 CaseResult 파싱.
// 격리는 네임스페이스(테넌트별) + runtimeClassName(gVisor/kata). NomadBackend 의 K8s 짝.
export class K8sBackend implements Backend {
  readonly id = "k8s";
  // 주입 api(테스트) 또는 비-kubeconfig 인증(context/server/token)으로 만든 장수명 api.
  // kubeconfig 인증이면 자격증명을 디스크에 오래 두지 않도록 디스패치마다 임시 kubeconfig 로 api 를 새로 만든다(withApi).
  private readonly staticApi?: K8sApi;

  constructor(private readonly opts: K8sBackendOptions) {
    if (opts.api) this.staticApi = opts.api;
    else if (!opts.kubeconfig)
      this.staticApi = kubectlApi({
        ...(opts.context ? { context: opts.context } : {}),
        ...(opts.server ? { server: opts.server } : {}),
        ...(opts.apiToken ? { token: opts.apiToken } : {}),
      });
  }

  // kubeconfig 인증이면 임시파일(0600)에 써서 그 경로의 kubectl 로 fn 을 실행하고 finally 에서 제거.
  // 그 외에는 장수명 staticApi 사용. 클러스터 자격증명을 untrusted 코드에 노출하지 않고 디스크에도 오래 남기지 않는다.
  private async withApi<T>(fn: (api: K8sApi) => Promise<T>): Promise<T> {
    if (this.staticApi) return fn(this.staticApi);
    const yaml = this.opts.kubeconfig;
    if (!yaml)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        undefined,
        "K8s 백엔드 인증 정보가 없습니다(context/server/token/kubeconfig).",
      );
    const { path, cleanup } = await materializeKubeconfig(yaml);
    try {
      return await fn(kubectlApi({ kubeconfig: path }));
    } finally {
      await cleanup();
    }
  }

  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    const total = (typeof mc === "function" ? mc() : mc) ?? 20;
    const used = await this.withApi((api) => api.countActiveJobs());
    return { total, used: used ?? 0 };
  }

  // 연결 테스트 — 잡 없이 API 서버 /version 으로 도달성 + 인증(context/token/kubeconfig)을 확인.
  async probe(): Promise<ProbeResult> {
    try {
      const version = await this.withApi((api) => api.serverVersion());
      return { reachable: true, detail: `K8s server ${version}` };
    } catch (e) {
      return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
    }
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
    // kubeconfig 인증이면 잡 1건 동안만 임시 kubeconfig 가 살아 있다(완료/실패 후 제거). deleteJob 이후 cleanup.
    return this.withApi(async (api) => {
      await api.ensureNamespace(ns);
      const manifest = buildK8sJob(job, { ...this.opts, secretEnv }, name, ns, runtimeClassName);
      // 워크스페이스 레지스트리 이미지면 dockerconfigjson Secret 을 Job 과 함께 apply(List) — 이름 고정, 멱등 upsert.
      const auth = job.registryAuth;
      const image = job.evalCase.image ?? this.opts.image;
      const payload =
        auth && imageUsesRegistryHost(image, auth.host)
          ? { apiVersion: "v1", kind: "List", items: [k8sRegistryAuthSecret(auth, ns), manifest] }
          : manifest;
      await api.applyJob(payload, ns);
      try {
        await this.waitForJob(api, name, ns);
        return parseResult(await api.podLogs(name, ns));
      } finally {
        await api.deleteJob(name, ns);
      }
    });
  }

  private async waitForJob(api: K8sApi, name: string, ns: string): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    for (let i = 0; i < maxPolls; i++) {
      const { succeeded, failed } = await api.jobStatus(name, ns);
      if (succeeded > 0) return;
      if (failed > 0) throw new UpstreamError("UPSTREAM_ERROR", { name, ns }, "K8s Job 실패");
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { name, ns }, "K8s Job 완료 대기 시간초과");
  }
}
