import { RESULT_SENTINEL } from "@assay/agent";
import { type AgentJob, type CaseResult, CaseResultSchema, UpstreamError } from "@assay/core";
import type { Backend } from "./backend.js";

// --- Nomad HTTP 추상화 (테스트에서 모킹 가능) ---
export interface NomadHttp {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
}

function fetchHttp(addr: string): NomadHttp {
  const base = addr.replace(/\/$/, "");
  return {
    async request(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export interface NomadBackendOptions {
  addr: string; // Nomad HTTP endpoint, e.g. http://nomad.internal:4646
  image: string; // 러너 에이전트 이미지 (사내 레지스트리)
  http?: NomadHttp;
  secretEnv?: Record<string, string>; // alloc 에 주입할 인증(예: CLAUDE_CODE_OAUTH_TOKEN)
  datacenters?: string[];
  runtime?: string; // docker 격리 런타임 (예: "runsc" = gVisor)
  cpuMhz?: number;
  memMb?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
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
    ...opts.secretEnv,
  };
  return {
    Job: {
      ID: nomadJobId(job),
      Type: "batch",
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
    this.http = opts.http ?? fetchHttp(opts.addr);
  }

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const submit = await this.http.request("POST", "/v1/jobs", buildNomadJob(job, this.opts));
    if (submit.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: submit.status }, "Nomad 잡 제출 실패");
    }
    const allocId = await this.waitForAlloc(nomadJobId(job));
    const logs = await this.http.request("GET", `/v1/client/fs/logs/${allocId}?task=agent&type=stdout&plain=true`);
    if (logs.status >= 300) throw new UpstreamError("UPSTREAM_ERROR", { status: logs.status }, "alloc 로그 조회 실패");
    return parseResult(logs.text);
  }

  private async waitForAlloc(jobId: string): Promise<string> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 900;
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.http.request("GET", `/v1/job/${jobId}/allocations`);
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
