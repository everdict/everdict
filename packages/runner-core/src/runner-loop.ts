import { type AgentJob, AgentJobSchema, type CaseResult } from "@everdict/core";

// 러너 lease 워커 풀의 의존성 — 전송/세션은 호출자(main.ts)가 ResilientMcpSession 으로 흡수하고,
// 여기서는 callJson(이미 JSON 파싱·재시도됨)과 잡 실행만 주입받아 순수한 lease 루프 로직만 담는다(테스트 용이).
export interface RunnerLoopDeps {
  // MCP tool 호출 → JSON 결과. 앱-레벨 에러(isError)는 throw 로 올라온다(호출자 wrapper 규약).
  callJson: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // 리스한 잡 실행(service→Docker 토폴로지 / 그 외→LocalDriver). runtimeOptions 등은 호출자가 클로저로 묶는다.
  runJob: (job: AgentJob) => Promise<CaseResult>;
  log?: (msg: string) => void; // 기본 no-op(테스트는 조용히)
  sleep?: (ms: number) => Promise<void>; // 기본 setTimeout
  // 실행 중 lease 갱신을 거는 훅 — 정리 함수를 돌려준다. 기본은 setInterval(heartbeat_job). 테스트는 가짜 주입.
  setHeartbeat?: (jobId: string) => () => void;
}

export interface RunnerLoopOpts {
  maxConcurrent: number; // 동시에 돌릴 워커(=동시 lease) 수. 한 러너 프로세스가 case-level 병렬을 실현하는 손잡이.
  waitMs: number; // lease long-poll 대기(서버가 잡 생길 때까지 잡아둠)
  heartbeatMs: number; // 실행 중 lease 갱신 주기
  pollMs: number; // lease 에러 backoff
  capabilities: string[]; // 매 lease 마다 자가-광고(repo/docker/browser)
  shouldStop: () => boolean; // SIGINT 등으로 정지 — 워커는 현재 잡을 끝낸 뒤 빠진다
}

// maxConcurrent 개의 워커 루프를 동시에 돌린다. 각 워커는 독립적으로 lease_job → runJob → submit_job_result 를
// 반복한다. RunnerHub.lease 는 단일 스레드 원자적이라(동기 실행 중 인터리브 없음) 동시 lease_job 가 같은 잡을
// 두 번 가져가지 않는다 → 워커들이 안전하게 서로 다른 케이스를 집어 한 배치를 병렬 실행한다.
// 설계: docs/architecture/self-hosted-runner.md.
export async function runLeaseWorkers(deps: RunnerLoopDeps, opts: RunnerLoopOpts): Promise<void> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setHeartbeat =
    deps.setHeartbeat ??
    ((jobId: string) => {
      const t = setInterval(() => {
        void deps.callJson("heartbeat_job", { jobId }).catch(() => {});
      }, opts.heartbeatMs);
      (t as { unref?: () => void }).unref?.();
      return () => clearInterval(t);
    });
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const worker = async (): Promise<void> => {
    while (!opts.shouldStop()) {
      let leased: Record<string, unknown>;
      try {
        leased = await deps.callJson("lease_job", { wait_ms: opts.waitMs, capabilities: opts.capabilities });
      } catch (e) {
        log(`✗ lease 실패: ${errMsg(e)}`);
        await sleep(opts.pollMs);
        continue;
      }
      if (!leased.job) {
        await sleep(250); // long-poll 타임아웃(잡 없음) — 즉시 재폴링(서버가 이미 대기)
        continue;
      }
      const jobId = String(leased.jobId);
      const parsed = AgentJobSchema.safeParse(leased.job); // 경계 검증
      if (!parsed.success) {
        log(`✗ 잡 ${jobId} 형식 오류 → fail 회신`);
        await deps.callJson("fail_job", { jobId, message: `잡 형식 오류: ${parsed.error.message}` }).catch(() => {});
        continue;
      }
      log(`▶ 잡 ${jobId} (case ${parsed.data.evalCase.id}) 실행 …`);
      // 장기 실행 잡이 서버에서 재큐되지 않게 주기적 heartbeat 로 lease 갱신.
      const stopHeartbeat = setHeartbeat(jobId);
      try {
        const result = await deps.runJob(parsed.data);
        await deps.callJson("submit_job_result", { jobId, result });
        log(`✓ 잡 ${jobId} 완료 → 회신`);
      } catch (e) {
        log(`✗ 잡 ${jobId} 실패: ${errMsg(e)} → fail 회신`);
        await deps.callJson("fail_job", { jobId, message: errMsg(e) }).catch(() => {});
      } finally {
        stopHeartbeat();
      }
    }
  };

  // 워커 풀 — 모두 같은 세션(callJson)을 공유한다(MCP 동시 호출 가능). shouldStop 으로 일제히 빠진다.
  await Promise.all(Array.from({ length: Math.max(1, opts.maxConcurrent) }, () => worker()));
}
