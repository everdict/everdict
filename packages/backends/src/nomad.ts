import { RESULT_SENTINEL } from "@assay/agent";
import {
  type AgentJob,
  type CaseResult,
  CaseResultSchema,
  UpstreamError,
  assertHardenedIsolation,
  judgeEnv,
} from "@assay/core";
import type { Backend, BackendCapacity } from "./backend.js";
import type { SecretProvider } from "./secrets.js";
import type { TrustZonePolicy } from "./trust-zone.js";

// --- Nomad HTTP 추상화 (테스트에서 모킹 가능) ---
export interface NomadHttp {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
}

// Nomad HTTP 클라이언트. apiToken 이 있으면 모든 요청에 X-Nomad-Token(ACL 인증)을 싣는다.
export function fetchHttp(addr: string, apiToken?: string, fetchImpl?: typeof fetch): NomadHttp {
  const base = addr.replace(/\/$/, "");
  const f = fetchImpl ?? fetch;
  return {
    async request(method, path, body) {
      const headers: Record<string, string> = {};
      if (body) headers["content-type"] = "application/json";
      if (apiToken) headers["x-nomad-token"] = apiToken; // 컨트롤플레인↔Nomad API 인증
      const res = await f(`${base}${path}`, {
        method,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export interface NomadBackendOptions {
  addr: string; // Nomad HTTP endpoint, e.g. http://nomad.internal:4646
  image: string; // 러너 에이전트 이미지 (사내 레지스트리)
  apiToken?: string; // Nomad ACL 토큰(X-Nomad-Token) — 컨트롤플레인↔Nomad API 인증. alloc env 와 무관.
  http?: NomadHttp;
  secretEnv?: Record<string, string>; // alloc 에 주입할 인증(예: CLAUDE_CODE_OAUTH_TOKEN). secrets 가 없을 때의 기본.
  secrets?: SecretProvider; // 테넌트별 시크릿 스코핑 — 잡마다 그 테넌트의 키만 주입(누출 금지).
  datacenters?: string[];
  runtime?: string; // docker 격리 런타임 (예: "runsc" = gVisor). trustZones 가 있으면 그쪽이 우선.
  namespace?: string; // 기본 네임스페이스(테넌트 존이 없을 때)
  trustZones?: TrustZonePolicy; // 테넌트별 격리 정책 — 런타임/네임스페이스를 잡마다 강제한다.
  cpuMhz?: number;
  memMb?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  // 이 클러스터의 동시 잡 상한(용량 인지 배치용). 함수면 오토스케일러가 바꾸는 값을 동적으로 읽는다.
  maxConcurrent?: number | (() => number);
}

// --- Nomad 잡 스펙(필요한 부분만 타입화) ---
interface NomadTask {
  Name: string;
  Driver: string;
  Config: { image: string; runtime?: string };
  Env: Record<string, string>;
  Resources: { CPU: number; MemoryMB: number };
}
export interface NomadJobSpec {
  Job: {
    ID: string;
    Type: string;
    Namespace?: string;
    Datacenters: string[];
    TaskGroups: Array<{
      Name: string;
      Count: number;
      RestartPolicy: { Attempts: number; Mode: string };
      Tasks: NomadTask[];
    }>;
  };
}

export function nomadJobId(job: AgentJob): string {
  return `assay-${job.evalCase.id}`;
}

// AgentJob → Nomad batch 잡 스펙. 잡 페이로드는 ASSAY_AGENT_JOB(base64) env 로 싣는다.
export function buildNomadJob(job: AgentJob, opts: NomadBackendOptions): NomadJobSpec {
  const env: Record<string, string> = {
    ASSAY_AGENT_JOB: Buffer.from(JSON.stringify(job)).toString("base64"),
    ...judgeEnv(job.judge), // per-run judge 모델 설정(키는 secretEnv). inline judge grader 가 이 모델로 판정.
    ...opts.secretEnv,
  };
  return {
    Job: {
      ID: nomadJobId(job),
      Type: "batch",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: [
        {
          Name: "eval",
          Count: 1,
          RestartPolicy: { Attempts: 0, Mode: "fail" },
          Tasks: [
            {
              Name: "agent",
              Driver: "docker",
              Config: opts.runtime ? { image: opts.image, runtime: opts.runtime } : { image: opts.image },
              Env: env,
              Resources: { CPU: opts.cpuMhz ?? 1000, MemoryMB: opts.memMb ?? 1024 },
            },
          ],
        },
      ],
    },
  };
}

function parseResult(stdout: string): CaseResult {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) throw new UpstreamError("UPSTREAM_ERROR", undefined, "에이전트 결과(sentinel)를 찾지 못했습니다.");
  const line = stdout.slice(idx + RESULT_SENTINEL.length).split("\n")[0] ?? "";
  return CaseResultSchema.parse(JSON.parse(line));
}

// 모델 B: 러너 에이전트를 Nomad batch alloc 으로 띄우고, 완료를 폴링한 뒤
// stdout 로그의 sentinel 에서 CaseResult 를 파싱한다.
export class NomadBackend implements Backend {
  readonly id = "nomad";
  private readonly http: NomadHttp;

  constructor(private readonly opts: NomadBackendOptions) {
    this.http = opts.http ?? fetchHttp(opts.addr, opts.apiToken);
  }

  // 용량: total=설정 상한, used=클러스터에서 관측된 진행중 assay 잡 수(라이브 프로브, 전 네임스페이스).
  // 프로브가 실패하면 used=0 으로 두고 스케줄러의 in-flight 로만 게이팅한다.
  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    const total = (typeof mc === "function" ? mc() : mc) ?? 20;
    try {
      const res = await this.http.request("GET", "/v1/jobs?prefix=assay-&namespace=*");
      if (res.status < 300) {
        const jobs = JSON.parse(res.text) as Array<{ Status?: string }>;
        const used = jobs.filter((j) => j.Status === "running" || j.Status === "pending").length;
        return { total, used };
      }
    } catch {
      // 프로브 실패 → used 0
    }
    return { total, used: 0 };
  }

  // 테넌트 존/시크릿을 잡마다 적용·강제: untrusted 는 강격리 필수, 전용 네임스페이스, 그 테넌트의 키만 주입.
  private async effectiveOpts(job: AgentJob): Promise<NomadBackendOptions> {
    const tenant = job.tenant ?? "default";
    const zone = this.opts.trustZones?.resolve(tenant);
    if (zone) assertHardenedIsolation(zone);
    // 시크릿 스코핑: provider 가 있으면 그 테넌트 것만, 없으면 기존 secretEnv.
    const secretEnv = this.opts.secrets ? await this.opts.secrets.secretsFor(tenant) : this.opts.secretEnv;
    if (!zone) return { ...this.opts, secretEnv };
    return {
      ...this.opts,
      secretEnv,
      runtime: zone.isolationRuntime,
      namespace: zone.namespace ?? this.opts.namespace,
    };
  }

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const opts = await this.effectiveOpts(job);
    const ns = opts.namespace;
    const submit = await this.http.request("POST", "/v1/jobs", buildNomadJob(job, opts));
    if (submit.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: submit.status }, "Nomad 잡 제출 실패");
    }
    const allocId = await this.waitForAlloc(nomadJobId(job), ns);
    const nsq = ns ? `&namespace=${encodeURIComponent(ns)}` : "";
    const logs = await this.http.request(
      "GET",
      `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true${nsq}`,
    );
    if (logs.status >= 300) throw new UpstreamError("UPSTREAM_ERROR", { status: logs.status }, "alloc 로그 조회 실패");
    return parseResult(logs.text);
  }

  private async waitForAlloc(jobId: string, namespace?: string): Promise<string> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    const nsq = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.http.request("GET", `/v1/job/${jobId}/allocations${nsq}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as Array<{ ID: string; ClientStatus: string }>;
        const alloc = allocs[0];
        if (alloc) {
          if (alloc.ClientStatus === "complete") return alloc.ID;
          if (alloc.ClientStatus === "failed" || alloc.ClientStatus === "lost") {
            throw new UpstreamError("UPSTREAM_ERROR", { alloc: alloc.ID, status: alloc.ClientStatus }, "alloc 실패");
          }
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { jobId }, "alloc 완료 대기 시간초과");
  }
}
