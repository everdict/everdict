import type { AgentJob, CaseResult } from "@assay/core";
import { detectCapabilities } from "./capabilities.js";
import { runLeasedJob } from "./run-leased-job.js";
import { runLeaseWorkers } from "./runner-loop.js";
import { type ConnectClient, ResilientMcpSession, mcpConnect } from "./runner-session.js";

// GUI 내장용 러너 퍼사드 — start/stop/상태 이벤트로 lease 루프를 감싼다(데스크톱 메인 프로세스가 소비).
// CLI 는 runLeaseWorkers 를 직접 쓰고, 데스크톱은 이 퍼사드를 쓴다 — 실행 동작 자체는 동일(runLeasedJob).
// 설계: docs/architecture/desktop-app.md.
export type RunnerHostState = "off" | "idle" | "running";

export interface RunnerHostStatus {
  state: RunnerHostState;
  activeJobs: number;
  capabilities: string[];
}

// 잡 1건의 종료 통지 — GUI(OS 알림 등)가 소비한다. 실패면 error, 성공이면 result 가 실린다.
export interface RunnerJobDone {
  job: AgentJob;
  result?: CaseResult;
  error?: Error;
}

export interface RunnerHostOpts {
  apiUrl: string; // 컨트롤플레인 base URL — /mcp 를 붙여 접속
  token: string; // rnr_ 페어링 토큰
  maxConcurrent?: number; // 기본 1(CLI 기본과 동일)
  waitMs?: number; // lease long-poll 대기(기본 25s)
  heartbeatMs?: number; // 실행 중 lease 갱신 주기(기본 30s)
  pollMs?: number; // lease 에러 backoff(기본 2s)
  capabilities?: string[]; // 미지정 → detectCapabilities()
  onStatus?: (status: RunnerHostStatus) => void;
  onJobDone?: (done: RunnerJobDone) => void; // 잡 종료 통지(성공/실패) — OS 알림 등
  log?: (msg: string) => void;
  // 테스트 주입점
  connect?: ConnectClient; // 기본 mcpConnect(new URL("/mcp", apiUrl), token)
  runJob?: (job: AgentJob) => Promise<CaseResult>; // 기본 runLeasedJob
  detect?: () => Promise<string[]>; // 기본 detectCapabilities
  sleep?: (ms: number) => Promise<void>;
}

export class RunnerHost {
  private stopFlag = false;
  private loop: Promise<void> | null = null;
  private session: ResilientMcpSession | null = null;
  private activeJobs = 0;
  private capabilities: string[] = [];

  constructor(private readonly opts: RunnerHostOpts) {}

  status(): RunnerHostStatus {
    const state: RunnerHostState = this.loop === null ? "off" : this.activeJobs > 0 ? "running" : "idle";
    return { state, activeJobs: this.activeJobs, capabilities: this.capabilities };
  }

  // 멱등 시작 — 이미 돌고 있으면 no-op. 초기 연결 실패는 루프가 backoff 재시도하므로 throw 하지 않는다.
  async start(): Promise<void> {
    if (this.loop) return;
    this.stopFlag = false;
    this.capabilities = this.opts.capabilities ?? (await (this.opts.detect ?? detectCapabilities)());
    const session = new ResilientMcpSession(
      this.opts.connect ?? mcpConnect(new URL("/mcp", this.opts.apiUrl), this.opts.token),
    );
    this.session = session;

    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await session.call(name, args);
      if (r.isError) throw new Error(r.text || `${name} 실패`);
      return JSON.parse(r.text) as Record<string, unknown>;
    };
    // image-케이스는 이 러너에 Docker 가 있을 때 로컬 Docker(DockerDriver)로 실행 — dockerAvailable 을 capability 에서 넘긴다.
    const dockerAvailable = this.capabilities.includes("docker");
    const baseRun = this.opts.runJob ?? ((job: AgentJob) => runLeasedJob(job, { dockerAvailable, log: this.opts.log }));
    // 잡 시작/종료를 감싸 activeJobs 를 추적(running/idle 이벤트 근거) + 종료 통지를 낸다.
    const runJob = async (job: AgentJob): Promise<CaseResult> => {
      this.activeJobs++;
      this.emit();
      try {
        const result = await baseRun(job);
        this.opts.onJobDone?.({ job, result });
        return result;
      } catch (e) {
        this.opts.onJobDone?.({ job, error: e instanceof Error ? e : new Error(String(e)) });
        throw e; // 루프가 fail_job 으로 회신하는 기존 경로 유지
      } finally {
        this.activeJobs--;
        this.emit();
      }
    };

    this.loop = runLeaseWorkers(
      { callJson, runJob, log: this.opts.log, sleep: this.opts.sleep },
      {
        maxConcurrent: Math.max(1, this.opts.maxConcurrent ?? 1),
        waitMs: this.opts.waitMs ?? 25_000,
        heartbeatMs: this.opts.heartbeatMs ?? 30_000,
        pollMs: this.opts.pollMs ?? 2_000,
        capabilities: this.capabilities,
        shouldStop: () => this.stopFlag,
      },
    ).finally(() => {
      this.loop = null;
      this.emit();
    });
    this.emit();
  }

  // 우아한 정지 — 진행 중 잡은 끝까지 실행·회신하고, 유휴 워커는 현재 long-poll(≤waitMs)이 끝나면 빠진다.
  async stop(): Promise<void> {
    this.stopFlag = true;
    const loop = this.loop;
    if (loop) await loop.catch(() => {});
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  private emit(): void {
    this.opts.onStatus?.(this.status());
  }
}
