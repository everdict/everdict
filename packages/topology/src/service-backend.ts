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
import { costGrader, latencyGrader, makeGraders, stepsGrader } from "@assay/graders";
import type { TraceSource } from "@assay/trace";
import { keysFor, newRunId } from "./environment-manager.js";
import type { TopologyRuntime } from "./topology-runtime.js";

// front-door 로 task+wiring 을 보내는 함수 (테스트에서 주입 가능).
export type SubmitFn = (frontDoorUrl: string, payload: Record<string, unknown>) => Promise<void>;

const fetchSubmit: SubmitFn = async (url, payload) => {
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
};

function submitPath(spec: string): string {
  const parts = spec.split(" ");
  return parts.length > 1 ? (parts[1] ?? spec) : spec;
}
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export interface ServiceTopologyBackendOptions {
  runtime: TopologyRuntime;
  traceSource: TraceSource;
  specFor: (tenant: string, id: string, version: string) => ServiceHarnessSpec | Promise<ServiceHarnessSpec>;
  graders?: Grader[]; // 기본: trace 기반(steps/cost/latency). 브라우저 그레이더(dom/vlm)는 Phase 2.
  submit?: SubmitFn;
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
      const submit = this.opts.submit ?? fetchSubmit;
      await submit(joinUrl(base, submitPath(spec.frontDoor.submit)), {
        task: job.evalCase.task,
        thread_id: keys.threadId,
        stream_channel: keys.streamChannel,
        minio_prefix: keys.minioPrefix,
        browser_cdp_url: browser.cdpUrl,
      });

      // 트레이스 소스 장애(인증/일시 down/미배출)는 run 을 죽이지 않는다 — error 이벤트로 기록하고 스냅샷+채점은 진행.
      // (서비스 토폴로지의 1차 신호는 브라우저 스냅샷; 트레이스는 보조. 침묵 손실 대신 가시화.)
      let trace: TraceEvent[];
      try {
        trace = await this.opts.traceSource.fetch(runId);
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
          ? makeGraders(job.evalCase.graders)
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
