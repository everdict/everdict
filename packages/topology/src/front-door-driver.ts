import type { FrontDoorCompletion, StatusMatch } from "@assay/core";

// front-door 로 task+wiring 을 POST 하는 함수(테스트에서 주입 가능).
export type SubmitFn = (frontDoorUrl: string, payload: Record<string, unknown>) => Promise<void>;
// 상태 폴링용 GET — JSON 응답을 그대로 돌려준다.
export type GetJsonFn = (url: string) => Promise<unknown>;

const fetchSubmit: SubmitFn = async (url, payload) => {
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
};
const fetchJson: GetJsonFn = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return res.json();
};

// "POST /runs" → { method: "POST", path: "/runs" }. method 토큰이 없으면 POST 로 본다.
export function methodPath(spec: string): { method: string; path: string } {
  const parts = spec.split(" ");
  if (parts.length > 1) return { method: parts[0] ?? "POST", path: parts[1] ?? spec };
  return { method: "POST", path: spec };
}
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
// {var} 토큰을 wiring 값으로 치환(단일 중괄호 — 기존 front-door path 관례 {id} 와 동일). 미매칭은 원문 유지.
export function interpolatePath(path: string, vars: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

// 상태 응답 JSON 에서 dot-path 필드를 안전하게 읽는다(eval 금지).
function getField(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}
function statusMatches(match: StatusMatch, body: unknown): boolean {
  const value = getField(body, match.field);
  if (match.equals !== undefined) return value === match.equals;
  if (match.oneOf !== undefined) return match.oneOf.some((v) => v === value);
  return false;
}

export type DriveStatus = "done" | "failed" | "timeout";
export interface DriveOutcome {
  // 트레이스를 끌어올 상관키. 이 슬라이스에선 injected(= assay runId); #3 에서 returned(에이전트 자체 id)로 일반화.
  traceRef: string;
  status: DriveStatus;
}

export interface FrontDoorDriveRequest {
  base: string; // front-door 서비스 베이스 URL
  submit: string; // spec.frontDoor.submit (예: "POST /runs")
  payload: Record<string, unknown>;
  completion: FrontDoorCompletion | undefined; // 미지정 = sync
  wiring: Record<string, string>; // statusPath 보간 변수({run_id} 등)
  traceRef: string;
}

// front-door 구동(HOW)의 추상화 — submit 후 완료 모델대로 대기. 인프라-비종속 TopologyRuntime(WHERE)의 형제.
export interface FrontDoorDriver {
  drive(req: FrontDoorDriveRequest): Promise<DriveOutcome>;
}

export interface HttpFrontDoorDriverIo {
  submit?: SubmitFn;
  getJson?: GetJsonFn;
  sleep?: (ms: number) => Promise<void>; // 테스트에서 no-op 주입(폴링 간격을 실제로 기다리지 않게)
  now?: () => number; // 테스트에서 가짜 시계 주입(타임아웃 결정성)
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 기본 HTTP 구동기 — submit(POST) 후 completion 모델대로 완료를 기다린다.
export class HttpFrontDoorDriver implements FrontDoorDriver {
  private readonly submit: SubmitFn;
  private readonly getJson: GetJsonFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(io: HttpFrontDoorDriverIo = {}) {
    this.submit = io.submit ?? fetchSubmit;
    this.getJson = io.getJson ?? fetchJson;
    this.sleep = io.sleep ?? realSleep;
    this.now = io.now ?? Date.now;
  }

  async drive(req: FrontDoorDriveRequest): Promise<DriveOutcome> {
    await this.submit(joinUrl(req.base, methodPath(req.submit).path), req.payload);
    const status = await this.awaitCompletion(req);
    return { traceRef: req.traceRef, status };
  }

  private async awaitCompletion(req: FrontDoorDriveRequest): Promise<DriveStatus> {
    const completion = req.completion;
    // sync(또는 미지정): submit 응답이 곧 완료 — 현행 동작.
    if (!completion || completion.mode === "sync") return "done";
    // poll: 상태 엔드포인트를 종료조건(done/failed) 또는 타임아웃까지 폴링.
    const statusUrl = joinUrl(req.base, interpolatePath(methodPath(completion.statusPath).path, req.wiring));
    const start = this.now();
    while (this.now() - start < completion.timeoutMs) {
      const body = await this.getJson(statusUrl);
      if (statusMatches(completion.done, body)) return "done";
      if (completion.failed && statusMatches(completion.failed, body)) return "failed";
      await this.sleep(completion.intervalMs);
    }
    return "timeout";
  }
}
