import type { Backend, BackendCapacity, TrustZonePolicy } from "@assay/backends";
import {
  type AgentJob,
  type CaseResult,
  type EnvSnapshot,
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
import { keysFor, newRunId, wiringVars } from "./environment-manager.js";
import {
  type FrontDoorDriver,
  type GetJsonFn,
  HttpFrontDoorDriver,
  type SubmitFn,
  interpolateTemplate,
} from "./front-door-driver.js";
import { applyImagePins } from "./image-pins.js";
import { observationSourceFor } from "./observation-source.js";
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
    const registered = await this.opts.specFor(job.tenant ?? "default", job.harness.id, job.harness.version);
    // per-dispatch 이미지 핀(#5) — 서비스 이미지를 런 시점에 override. 핀이 있으면 effective version 에 접미사가 붙어
    // warm 풀이 별개 정체성으로 분리된다(같은 토폴로지를 service X v1↔v2 로 평가 가능).
    const spec = applyImagePins(registered, job.imagePins);
    const runId = (this.opts.newRunId ?? newRunId)();
    const keys = keysFor(runId);

    // 테넌트 존 해석 — untrusted 는 강격리 강제, warm 풀은 존별로 분리된다.
    let zone: TrustZone | undefined;
    if (this.opts.trustZones) {
      zone = this.opts.trustZones.resolve(job.tenant ?? "default");
      assertHardenedIsolation(zone);
    }

    const topo = await this.opts.runtime.ensureTopology(spec, zone);
    // 타깃 관측(#4): spec.target 이 선언됐을 때만 per-case 브라우저를 프로비저닝(스키마상 이미 optional).
    // 없으면 관측 무대 없이 trace-only — 자체 브라우저/무대 없는 서비스 하니스를 지원.
    const target = spec.target ? await this.opts.runtime.provisionBrowserEnv(spec, runId, zone) : undefined;
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
      // per-run 와이어링 — isolateBy 파생 격리 변수(+ task + 타깃이 있으면 target_cdp_url). 본문 템플릿 + statusPath 공용.
      const wiring = wiringVars(runId, spec.dependencies, {
        task: job.evalCase.task,
        ...(target ? { target_cdp_url: target.cdpUrl } : {}),
      });
      // 본문(#1): request.bodyTemplate 이 있으면 wiring 으로 보간, 없으면 현행 browser-use 5-field 본문(무회귀).
      // 타깃이 없으면 browser_cdp_url 은 뺀다(브라우저가 없으므로).
      const payload = spec.frontDoor.request?.bodyTemplate
        ? interpolateTemplate(spec.frontDoor.request.bodyTemplate, wiring)
        : {
            task: job.evalCase.task,
            thread_id: keys.threadId,
            stream_channel: keys.streamChannel,
            minio_prefix: keys.minioPrefix,
            ...(target ? { browser_cdp_url: target.cdpUrl } : {}),
          };
      const outcome = await driver.drive({
        base,
        submit: spec.frontDoor.submit,
        payload,
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
      // 관측(#4 + delivery): delivery.mode 별 ObservationSource 로 관측물 회수. 미설정=reference(store-fetch, 무회귀)
      // — 타깃 있으면 스냅샷 pull, 없으면 prompt. sentinel = outcome.response(결과 채널)에서 인라인 추출. egress=후속.
      const snapshot: EnvSnapshot = await observationSourceFor(spec.target?.delivery).observe({
        target,
        response: outcome.response,
      });

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
      if (target) await target.dispose();
    }
  }
}
