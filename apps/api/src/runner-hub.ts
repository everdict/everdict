import { randomUUID } from "node:crypto";
import { type AgentJob, type CaseResult, UpstreamError } from "@assay/core";

// 셀프호스티드 러너 디스패치 키 — 잡이 흘러갈 러너의 정체성. lease 큐는 (owner, runnerId)로 키된다(D3).
// ⚠️ 워크스페이스(tenant)는 키에 넣지 않는다 — 러너는 소유자가 속한 여러 워크스페이스의 잡을 한 큐에서 받는다
// (크로스 워크스페이스). 잡 자신이 tenant 를 들고 다니므로 결과는 올바른 워크스페이스에 기록된다.
export interface SelfHostedKey {
  owner: string; // 러너 소유자 = principal.subject
  runnerId: string;
}

export function selfHostedBackendName(key: SelfHostedKey): string {
  return `self:${key.owner}:${key.runnerId}`;
}

// 러너가 lease 로 가져가는 잡 한 건(MCP lease_job 응답의 코어).
export interface LeasedJob {
  jobId: string;
  job: AgentJob;
}

interface PendingEntry {
  jobId: string;
  job: AgentJob;
  resolve: (r: CaseResult) => void;
  reject: (e: Error) => void;
  leasedAt?: number; // 러너가 가져간 시각(undefined=대기 중). Slice 6 의 만료/재큐가 이걸 본다.
  timer: ReturnType<typeof setTimeout>;
}

export interface RunnerHubDeps {
  // 잡에 '활동(lease/heartbeat)'이 없는 채로 매달릴 수 있는 최대 시간 — lease/heartbeat 가 리셋한다.
  // 활발히 heartbeat 하는 러너의 장기 실행 잡은 무기한 살아있고, 미연결/유휴/사망 러너의 잡만 이 시간 뒤 거부된다.
  queueTimeoutMs?: number;
  // 러너가 lease 한 뒤 complete/heartbeat 없이 이 시간이 지나면 재큐(러너 사망/네트워크 단절 → 다른/재접속 러너가 가져감).
  leaseTtlMs?: number;
  newJobId?: () => string;
  now?: () => number;
}

// 개인 소유 셀프호스티드 러너의 인메모리 lease 허브 — push→pull 의 핵심.
// SelfHostedBackend.dispatch 가 잡을 여기 파킹(promise 반환)하고, 러너 프로토콜(MCP, Slice 4)이
// lease(가져가기)/complete(결과 회신)로 그 promise 를 resolve 한다. 키별(=러너별) FIFO 큐.
// 설계: docs/architecture/self-hosted-runner.md.
export class RunnerHub {
  private readonly queues = new Map<string, PendingEntry[]>();
  private readonly waiters = new Map<string, Array<() => void>>(); // long-poll lease 대기자(키별 wake 콜백)
  private readonly queueTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly newJobId: () => string;
  private readonly now: () => number;
  constructor(deps: RunnerHubDeps = {}) {
    this.queueTimeoutMs = deps.queueTimeoutMs ?? 300_000; // 기본 5분
    this.leaseTtlMs = deps.leaseTtlMs ?? 120_000; // 기본 2분(heartbeat 로 갱신)
    this.newJobId = deps.newJobId ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  private q(key: SelfHostedKey): PendingEntry[] {
    const k = selfHostedBackendName(key);
    let arr = this.queues.get(k);
    if (!arr) {
      arr = [];
      this.queues.set(k, arr);
    }
    return arr;
  }

  // 잡을 파킹하고 결과 promise 를 돌려준다(SelfHostedBackend.dispatch). 러너가 complete 하면 resolve,
  // '활동(lease/heartbeat)' 없이 queueTimeoutMs 가 지나면 reject(미연결/유휴). 키별 FIFO.
  enqueue(key: SelfHostedKey, job: AgentJob): Promise<CaseResult> {
    const jobId = this.newJobId();
    const arr = this.q(key);
    // 실행자는 동기 실행이라 resolve/reject 가 곧바로 재할당된다(no-op 초기값은 no-`!` 규율 준수용).
    let resolve: (r: CaseResult) => void = () => {};
    let reject: (e: Error) => void = () => {};
    const promise = new Promise<CaseResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: PendingEntry = { jobId, job, resolve, reject, timer: this.armTimeout(key, jobId, reject) };
    arr.push(entry);
    // long-poll 대기 중인 러너가 있으면 깨운다(단일 스레드 → wake 안에서 lease 가 곧장 이 잡을 가져간다).
    this.waiters.get(selfHostedBackendName(key))?.shift()?.();
    return promise;
  }

  // '유휴 타임아웃' 타이머 — queueTimeoutMs 동안 활동(lease/heartbeat)이 없으면 잡을 거부한다.
  // lease/heartbeat 가 이 타이머를 리셋하므로, 활발히 heartbeat 하는 러너의 장기 실행 잡(codex/claude-code 등
  // 수 분~수십 분)은 절대 잘못 거부되지 않는다. 아무 러너도 안 가져가거나(미연결/유휴), 가져간 뒤 러너가 죽어
  // heartbeat 가 끊기면 이 시간 뒤 no_runner 로 거부.
  private armTimeout(key: SelfHostedKey, jobId: string, reject: (e: Error) => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.remove(key, jobId);
      // reject 가 어딘가에서 삼켜지면 "이유없이 조용히 실패"로 보인다 — 원인(미연결/유휴)과 시간을 서버 로그로 가시화.
      console.warn(
        `[runner-hub] 유휴 타임아웃: 러너 ${selfHostedBackendName(key)} 가 ${this.queueTimeoutMs}ms 동안 잡 ${jobId} 에 활동(lease/heartbeat)이 없습니다 — 미연결/유휴로 판단.`,
      );
      reject(
        new UpstreamError(
          "UPSTREAM_ERROR",
          { runnerId: key.runnerId, reason: "no_runner" },
          "셀프호스티드 러너 활동이 없습니다 — 연결된 러너가 없거나 유휴/사망 상태입니다.",
        ),
      );
    }, this.queueTimeoutMs);
    // 타이머가 프로세스를 붙잡지 않게(테스트/종료 친화). Node 외 런타임엔 unref 없음 → 옵셔널 체이닝.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  // 활동 시 유휴 타임아웃을 리셋(lease 로 가져가거나 heartbeat 할 때). 기존 타이머를 갈아끼운다.
  private rearm(key: SelfHostedKey, entry: PendingEntry): void {
    clearTimeout(entry.timer);
    entry.timer = this.armTimeout(key, entry.jobId, entry.reject);
  }

  // 다음 미-lease 잡을 가져간다(러너 pull). 없으면 null(러너는 재폴링). leasedAt 기록.
  // 먼저 lease 가 만료된 잡(러너 사망/단절)을 재큐한다 — 다른/재접속 러너가 다시 가져갈 수 있게.
  lease(key: SelfHostedKey): LeasedJob | null {
    const arr = this.q(key);
    const now = this.now();
    for (const e of arr) {
      if (e.leasedAt !== undefined && now - e.leasedAt > this.leaseTtlMs) e.leasedAt = undefined; // 재큐
    }
    const entry = arr.find((e) => e.leasedAt === undefined);
    if (!entry) return null;
    entry.leasedAt = now;
    this.rearm(key, entry); // 러너가 가져감 → 유휴 타임아웃 리셋(이제 heartbeat 가 살아있게 유지)
    return { jobId: entry.jobId, job: entry.job };
  }

  // long-poll lease — 즉시 가져갈 잡이 없으면 다음 enqueue(또는 waitMs 타임아웃)까지 대기 후 1건 반환(없으면 null).
  // 러너가 타이트 루프로 재폴링하지 않게 한다(서버가 잡이 생길 때까지 잡아둔다).
  leaseWait(key: SelfHostedKey, waitMs: number): Promise<LeasedJob | null> {
    const immediate = this.lease(key);
    if (immediate || waitMs <= 0) return Promise.resolve(immediate);
    const k = selfHostedBackendName(key);
    return new Promise<LeasedJob | null>((resolve) => {
      let done = false;
      const finish = (v: LeasedJob | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const a = this.waiters.get(k);
        const i = a?.indexOf(wake) ?? -1;
        if (a && i >= 0) a.splice(i, 1);
        resolve(v);
      };
      const wake = () => finish(this.lease(key)); // enqueue 가 깨움 → 곧장 그 잡을 lease
      const timer = setTimeout(() => finish(null), waitMs);
      (timer as { unref?: () => void }).unref?.();
      const arr = this.waiters.get(k) ?? [];
      arr.push(wake);
      this.waiters.set(k, arr);
    });
  }

  // 러너 생존 신호 — lease 를 갱신(leasedAt 갱신)해 장기 실행 잡이 재큐되지 않게 한다. 큐에 없으면 false.
  heartbeat(key: SelfHostedKey, jobId: string): boolean {
    const entry = this.q(key).find((e) => e.jobId === jobId);
    if (!entry) return false;
    entry.leasedAt = this.now();
    this.rearm(key, entry); // 생존 신호 → 유휴 타임아웃 리셋(장기 실행 잡이 잘못 거부되지 않게)
    return true;
  }

  // 러너가 결과를 회신 → 파킹된 promise resolve. 큐에 없으면 false(이미 완료/만료/미상).
  complete(key: SelfHostedKey, jobId: string, result: CaseResult): boolean {
    const entry = this.remove(key, jobId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  // 러너가 잡 실행 실패를 회신 → promise reject(우리 에러로 remap). 큐에 없으면 false.
  fail(key: SelfHostedKey, jobId: string, message: string): boolean {
    const entry = this.remove(key, jobId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.reject(new UpstreamError("UPSTREAM_ERROR", { runnerId: key.runnerId, jobId }, message));
    return true;
  }

  // 대기/lease 중 잡 수(capacity/관측용).
  pending(key: SelfHostedKey): number {
    return this.q(key).length;
  }

  private remove(key: SelfHostedKey, jobId: string): PendingEntry | undefined {
    const arr = this.q(key);
    const i = arr.findIndex((e) => e.jobId === jobId);
    if (i < 0) return undefined;
    return arr.splice(i, 1)[0];
  }
}
