import { type FrontDoorCompletion, type FrontDoorCorrelate, type StatusMatch, UpstreamError } from "@assay/core";

// front-door 로 task+wiring 을 POST 하는 함수 — 응답 본문(JSON)을 돌려준다(returned 상관에서 trace-id 추출용).
// 테스트에서 주입 가능. (injected 상관은 본문이 불필요하므로 void 반환도 허용.)
export type SubmitFn = (frontDoorUrl: string, payload: Record<string, unknown>) => Promise<unknown>;
// 상태 폴링용 GET — JSON 응답을 그대로 돌려준다.
export type GetJsonFn = (url: string) => Promise<unknown>;
// 스트리밍 submit(stream 완료 모델) — POST 응답(SSE/JSON-lines)을 파싱된 이벤트 비동기 시퀀스로 돌려준다.
// timeoutMs 는 소켓 hard-abort 용(논리 타임아웃은 드라이버가 이벤트마다 now() 로 별도 체크). 테스트는 가짜 async iterable 주입.
export type OpenStreamFn = (
  url: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => AsyncIterable<unknown>;

const fetchSubmit: SubmitFn = async (url, payload) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // 응답이 JSON 이 아니거나 비어도 injected 모드는 본문이 불필요 → 관용적으로 파싱.
  try {
    return await res.json();
  } catch {
    return undefined;
  }
};
// 기본 JSON GET — poll 완료 + egress sink 회수의 기본 프리미티브(주입 안 하면 이걸 쓴다).
export const fetchJson: GetJsonFn = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return res.json();
};

// 기본 SSE 스트리밍 submit — POST 후 text/event-stream 본문을 이벤트(\n\n 구분, data: 라인)별로 JSON 파싱해 yield.
// 비-JSON data 는 건너뛴다. timeoutMs 면 AbortController 로 소켓을 끊는다(스톨 방지). 주입 안 하면 stream 모델이 이걸 쓴다.
export const fetchStream: OpenStreamFn = async function* (url, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = timeoutMs !== undefined ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) {
          try {
            yield JSON.parse(data);
          } catch {
            // 비-JSON data 이벤트는 무시(주석/keep-alive 등)
          }
        }
        sep = buf.indexOf("\n\n");
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

// 본문 템플릿 보간(#1) — JSON 을 재귀적으로 훑어 문자열 값의 {{var}} 토큰을 wiring 으로 치환(이중 중괄호 —
// CommandHarness {{task}} 관례). 미매칭 토큰은 원문 유지. 비문자열(숫자/불리언/null)은 그대로.
function interpolateValue(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, vars));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateValue(v, vars);
    return out;
  }
  return value;
}
export function interpolateTemplate(
  template: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) out[k] = interpolateValue(v, vars);
  return out;
}

// 상태 응답 JSON 에서 dot-path 필드를 안전하게 읽는다(eval 금지). sentinel 관측물 추출도 이걸 재사용.
export function getField(obj: unknown, path: string): unknown {
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

// 상관키(traceRef) 결정 — injected(주입 runId, 현행) vs returned(submit 응답에서 dot-path 추출).
function resolveTraceRef(correlate: FrontDoorCorrelate | undefined, injected: string, response: unknown): string {
  if (!correlate || correlate.mode === "injected") return injected;
  const value = getField(response, correlate.path);
  if (typeof value !== "string" || value === "") {
    // 에이전트 응답이 선언된 상관 계약과 불일치 — 침묵 대신 명확히 실패(외부 계약 오류).
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { path: correlate.path, got: value },
      `front-door submit 응답에서 trace-id(${correlate.path})를 찾지 못했습니다.`,
    );
  }
  return value;
}

export type DriveStatus = "done" | "failed" | "timeout";
export interface DriveOutcome {
  // 트레이스를 끌어올 상관키. 이 슬라이스에선 injected(= assay runId); #3 에서 returned(에이전트 자체 id)로 일반화.
  traceRef: string;
  status: DriveStatus;
  // 결과 채널 본문 — sync 면 submit 응답, poll 면 완료(done) 상태 본문. sentinel 관측물 회수가 여기서 추출한다.
  // optional: fire-and-forget 등 응답이 없는 커스텀 driver 도 허용(그 경우 sentinel 회수는 형식 불일치로 명확히 실패).
  response?: unknown;
}

export interface FrontDoorDriveRequest {
  base: string; // front-door 서비스 베이스 URL
  submit: string; // spec.frontDoor.submit (예: "POST /runs")
  payload: Record<string, unknown>;
  completion: FrontDoorCompletion | undefined; // 미지정 = sync
  correlate: FrontDoorCorrelate | undefined; // 미지정 = injected
  wiring: Record<string, string>; // statusPath 보간 변수({run_id} 등)
  traceRef: string; // injected 상관의 기본 상관키(= assay runId)
}

// front-door 구동(HOW)의 추상화 — submit 후 완료 모델대로 대기. 인프라-비종속 TopologyRuntime(WHERE)의 형제.
export interface FrontDoorDriver {
  drive(req: FrontDoorDriveRequest): Promise<DriveOutcome>;
}

export interface HttpFrontDoorDriverIo {
  submit?: SubmitFn;
  getJson?: GetJsonFn;
  openStream?: OpenStreamFn; // stream 완료 모델의 SSE 소비 프리미티브(주입 안 하면 fetchStream)
  sleep?: (ms: number) => Promise<void>; // 테스트에서 no-op 주입(폴링 간격을 실제로 기다리지 않게)
  now?: () => number; // 테스트에서 가짜 시계 주입(타임아웃 결정성)
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 기본 HTTP 구동기 — submit(POST) 후 completion 모델대로 완료를 기다린다.
export class HttpFrontDoorDriver implements FrontDoorDriver {
  private readonly submit: SubmitFn;
  private readonly getJson: GetJsonFn;
  private readonly openStream: OpenStreamFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(io: HttpFrontDoorDriverIo = {}) {
    this.submit = io.submit ?? fetchSubmit;
    this.getJson = io.getJson ?? fetchJson;
    this.openStream = io.openStream ?? fetchStream;
    this.sleep = io.sleep ?? realSleep;
    this.now = io.now ?? Date.now;
  }

  async drive(req: FrontDoorDriveRequest): Promise<DriveOutcome> {
    // stream: submit 응답이 곧 이벤트 스트림 — request/response 가 아니므로 별도 경로(첫 이벤트로 상관, 종단 이벤트로 판정).
    if (req.completion?.mode === "stream") return this.driveStream(req, req.completion);
    const response = await this.submit(joinUrl(req.base, methodPath(req.submit).path), req.payload);
    // 상관(#3): injected = 주입한 runId(현행), returned = 에이전트가 응답으로 돌려준 자기 id.
    const traceRef = resolveTraceRef(req.correlate, req.traceRef, response);
    // returned 면 poll statusPath 도 에이전트 id 로 보간되도록 run_id 를 그 id 로 덮는다(injected 는 동일값 → no-op).
    const wiring = { ...req.wiring, run_id: traceRef };
    const completion = await this.awaitCompletion(req.completion, req.base, wiring);
    // 결과 채널 본문: poll 이면 완료 상태 본문, sync 면 submit 응답. sentinel 회수가 이걸 읽는다.
    return { traceRef, status: completion.status, response: completion.body ?? response };
  }

  // stream: submit POST 응답을 이벤트 스트림으로 소비. 첫 이벤트로 상관(returned 면 에이전트 id 추출),
  // 이후 각 이벤트를 failed→done 순으로 StatusMatch. 종단 이벤트가 결과 채널 본문(sentinel 회수 대상).
  private async driveStream(
    req: FrontDoorDriveRequest,
    completion: Extract<FrontDoorCompletion, { mode: "stream" }>,
  ): Promise<DriveOutcome> {
    const url = joinUrl(req.base, methodPath(req.submit).path);
    const start = this.now();
    let traceRef = req.traceRef;
    let correlated = false;
    let last: unknown;
    for await (const event of this.openStream(url, req.payload, completion.timeoutMs)) {
      if (!correlated) {
        // 첫 이벤트로 상관 — A2A 는 Task.id 를 선발행하므로 첫 이벤트에 자기 id 가 있다(returned). injected 는 no-op.
        traceRef = resolveTraceRef(req.correlate, req.traceRef, event);
        correlated = true;
      }
      last = event;
      if (completion.failed && statusMatches(completion.failed, event))
        return { traceRef, status: "failed", response: event };
      if (statusMatches(completion.done, event)) return { traceRef, status: "done", response: event };
      if (this.now() - start >= completion.timeoutMs) return { traceRef, status: "timeout", response: last };
    }
    // 스트림이 종단 매치 없이 끝남 → 완료를 확정할 수 없음(timeout 과 동일 취급 → dispatch 가 run 실패).
    return { traceRef, status: "timeout", response: last };
  }

  private async awaitCompletion(
    completion: FrontDoorCompletion | undefined,
    base: string,
    wiring: Record<string, string>,
  ): Promise<{ status: DriveStatus; body: unknown }> {
    // poll 이 아니면(sync/미지정): submit 응답이 곧 완료 — 현행 동작. 결과 본문은 호출부의 submit 응답을 쓴다(body=undefined).
    // (stream 은 drive() 가 별도 경로로 처리하므로 여기 오지 않는다.)
    if (!completion || completion.mode !== "poll") return { status: "done", body: undefined };
    // poll: 상태 엔드포인트를 종료조건(done/failed) 또는 타임아웃까지 폴링. 완료 본문을 결과 채널로 돌려준다.
    const statusUrl = joinUrl(base, interpolatePath(methodPath(completion.statusPath).path, wiring));
    const start = this.now();
    while (this.now() - start < completion.timeoutMs) {
      const body = await this.getJson(statusUrl);
      if (statusMatches(completion.done, body)) return { status: "done", body };
      if (completion.failed && statusMatches(completion.failed, body)) return { status: "failed", body };
      await this.sleep(completion.intervalMs);
    }
    return { status: "timeout", body: undefined };
  }
}
