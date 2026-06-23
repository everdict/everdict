import type { Backend, BackendCapacity, TrustZonePolicy } from "@assay/backends";
import {
  type AgentJob,
  type CaseResult,
  type Grader,
  InternalError,
  type Score,
  type ServiceHarnessSpec,
  type TraceEvent,
  type TrustZone,
  assertHardenedIsolation,
} from "@assay/core";
import { costGrader, latencyGrader, makeGradersFromEnv, stepsGrader } from "@assay/graders";
import type { TraceSource } from "@assay/trace";
import { keysFor, newRunId } from "./environment-manager.js";
import { type FrontDoorDriver, type GetJsonFn, HttpFrontDoorDriver, type SubmitFn } from "./front-door-driver.js";
import type { TopologyRuntime } from "./topology-runtime.js";

// 하위호환 re-export — 기존 import { type SubmitFn } from "./service-backend.js" 유지.
export type { SubmitFn } from "./front-door-driver.js";

export interface ServiceTopologyBackendOptions {
  runtime: TopologyRuntime;
  traceSource: TraceSource;
  specFor: (tenant: string, id: string, version: string) => ServiceHarnessSpec | Promise<ServiceHarnessSpec>;
  graders?: Grader[]; // 기본: trace 기반(steps/cost/latency). 브라우저 그레이더(dom/vlm)는 Phase 2.
  submit?: SubmitFn; // 기본 HttpFrontDoorDriver 의 POST 프리미티브(없으면 fetch)
  getJson?: GetJsonFn; // poll 완료 모델의 상태 GET 프리미티브(없으면 fetch)
  frontDoorDriver?: FrontDoorDriver; // 구동(HOW) 추상화 전체를 주입(없으면 HttpFrontDoorDriver)
  newRunId?: () => string;
  maxConcurrent?: number | (() => number); // 동시 per-case 브라우저 상한(함수면 오토스케일러가 동적 조정)
  trustZones?: TrustZonePolicy; // 테넌트별 격리 — warm 풀을 존별로 분리(공유 금지)
}

// 오케스트레이터-비종속 서비스 토폴로지 백엔드 (Backend 구현).
// ensure warm topology → per-case 브라우저 → drive(front-door, per-run wiring) → collectTrace → observe → grade.
export class ServiceTopologyBackend implements Backend {
  readonly id: string;
  constructor(private readonly opts: ServiceTopologyBackendOptions) {
    this.id = `service:${opts.runtime.id}`;
  }

  // 용량: 동시에 띄울 수 있는 per-case 브라우저 수(warm 서비스는 공유 풀이라 per-case 가 병목).
  async capacity(): Promise<BackendCapacity> {
    const mc = this.opts.maxConcurrent;
    return { total: (typeof mc === "function" ? mc() : mc) ?? 8, used: 0 };
  }

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const spec = await this.opts.specFor(job.tenant ?? "default", job.harness.id, job.harness.version);
    const runId = (this.opts.newRunId ?? newRunId)();
    const keys = keysFor(runId);

    // 테넌트 존 해석 — untrusted 는 강격리 강제, warm 풀은 존별로 분리된다.
    let zone: TrustZone | undefined;
    if (this.opts.trustZones) {
      zone = this.opts.trustZones.resolve(job.tenant ?? "default");
      assertHardenedIsolation(zone);
    }

    const topo = await this.opts.runtime.ensureTopology(spec, zone);
    const browser = await this.opts.runtime.provisionBrowserEnv(spec, runId, zone);
    try {
      const base = topo.endpoints[spec.frontDoor.service];
      if (!base) {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { service: spec.frontDoor.service },
          "front-door 엔드포인트가 없습니다.",
        );
      }
      // 구동(HOW): submit + per-run wiring 주입 → 완료 모델(sync/poll)대로 대기. 인프라(WHERE)와 분리된 관심사.
      const driver =
        this.opts.frontDoorDriver ?? new HttpFrontDoorDriver({ submit: this.opts.submit, getJson: this.opts.getJson });
      // statusPath 보간용 wiring 변수 — 의존 스토어의 isolateBy 키(+ run_id). #3 에서 상관키로도 일반화 예정.
      const wiring: Record<string, string> = {
        run_id: runId,
        thread_id: keys.threadId,
        stream_channel: keys.streamChannel,
        minio_prefix: keys.minioPrefix,
      };
      const outcome = await driver.drive({
        base,
        submit: spec.frontDoor.submit,
        payload: {
          task: job.evalCase.task,
          thread_id: keys.threadId,
          stream_channel: keys.streamChannel,
          minio_prefix: keys.minioPrefix,
          browser_cdp_url: browser.cdpUrl,
        },
        completion: spec.frontDoor.completion,
        correlate: spec.frontDoor.correlate,
        wiring,
        traceRef: runId,
      });
      // 완료 시한 초과 = 평가 결과를 확정할 수 없음(반쪽 상태 채점은 오인 유발) → run 실패로 명시.
      if (outcome.status === "timeout") {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { runId, reason: "completion-timeout" },
          "에이전트가 완료 시한 내에 끝나지 않았습니다.",
        );
      }

      // 트레이스 소스 장애(인증/일시 down/미배출)는 run 을 죽이지 않는다 — error 이벤트로 기록하고 스냅샷+채점은 진행.
      // (서비스 토폴로지의 1차 신호는 브라우저 스냅샷; 트레이스는 보조. 침묵 손실 대신 가시화.)
      let trace: TraceEvent[];
      try {
        trace = await this.opts.traceSource.fetch(outcome.traceRef);
      } catch (err) {
        trace = [
          { t: 0, kind: "error", message: `trace fetch 실패: ${err instanceof Error ? err.message : String(err)}` },
        ];
      }
      const snapshot = await browser.snapshot();

      // 케이스가 그레이더를 지정하면 그것으로(dom-contains/url-matches 등), 아니면 trace 기반 기본값.
      const graders =
        this.opts.graders ??
        (job.evalCase.graders.length > 0
          ? makeGradersFromEnv(job.evalCase.graders) // judge grader 포함(env Judge; 미구성이면 judge 만 skip)
          : [stepsGrader, costGrader, latencyGrader]);
      const scores: Score[] = [];
      for (const grader of graders) {
        scores.push(await grader.grade({ case: job.evalCase, trace, snapshot }));
      }

      return { caseId: job.evalCase.id, harness: `${spec.id}@${spec.version}`, trace, snapshot, scores };
    } finally {
      await browser.dispose();
    }
  }
}
