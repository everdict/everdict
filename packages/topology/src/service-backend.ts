import type { Backend } from "@assay/backends";
import {
  type AgentJob,
  type CaseResult,
  type Grader,
  InternalError,
  type Score,
  type ServiceHarnessSpec,
} from "@assay/core";
import { costGrader, latencyGrader, stepsGrader } from "@assay/graders";
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
  specFor: (id: string, version: string) => ServiceHarnessSpec;
  graders?: Grader[]; // 기본: trace 기반(steps/cost/latency). 브라우저 그레이더(dom/vlm)는 Phase 2.
  submit?: SubmitFn;
  newRunId?: () => string;
}

// 오케스트레이터-비종속 서비스 토폴로지 백엔드 (Backend 구현).
// ensure warm topology → per-case 브라우저 → drive(front-door, per-run wiring) → collectTrace → observe → grade.
export class ServiceTopologyBackend implements Backend {
  readonly id: string;
  constructor(private readonly opts: ServiceTopologyBackendOptions) {
    this.id = `service:${opts.runtime.id}`;
  }

  async dispatch(job: AgentJob): Promise<CaseResult> {
    const spec = this.opts.specFor(job.harness.id, job.harness.version);
    const runId = (this.opts.newRunId ?? newRunId)();
    const keys = keysFor(runId);

    const topo = await this.opts.runtime.ensureTopology(spec);
    const browser = await this.opts.runtime.provisionBrowserEnv(spec, runId);
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

      const trace = await this.opts.traceSource.fetch(runId);
      const snapshot = await browser.snapshot();

      const graders = this.opts.graders ?? [stepsGrader, costGrader, latencyGrader];
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
