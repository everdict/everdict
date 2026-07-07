import { type EnvSnapshot, EnvSnapshotSchema, InternalError, type ObservationDelivery } from "@everdict/core";
import { getField, interpolatePath } from "./front-door-driver.js";

// 관측물(observation/관측물) 회수 추상화 — TopologyRuntime(WHERE)/FrontDoorDriver(HOW-drive) 의 형제(HOW-observe).
// delivery.mode 별로 관측물이 grader/judge 에 도달하는 경로가 다르다:
//   reference — 평가가 store(브라우저 CDP 등)에서 pull (현행, 무회귀). store-locality(co-locate)와 짝.
//   sentinel  — 실행이 결과 채널(front-door 응답)로 인라인 반환. store hop 없음 — 작은 관측물에 유리.
//   egress    — 실행이 sink 로 push, 평가는 그 sink 에서 회수. judge 가 멀 때 pull 대신 push.
// 설계: docs/architecture/judge-placement-locality.md.

// per-case 타깃의 관측 표면만(snapshot) — provisionBrowserEnv 핸들이 구조적으로 만족한다. 런타임 결합 최소화.
export interface ObservationTarget {
  snapshot(): Promise<EnvSnapshot>;
}

export interface ObserveRequest {
  target: ObservationTarget | undefined; // 무대 없으면 undefined → reference 는 prompt 스냅샷
  response?: unknown; // 결과 채널 본문(DriveOutcome.response) — sentinel 이 여기서 관측물을 추출
  getJson?: (url: string) => Promise<unknown>; // egress sink 회수 fetch 프리미티브
  wiring?: Record<string, string>; // sink/path 보간 변수({run_id} 등)
}

export interface ObservationSource {
  observe(req: ObserveRequest): Promise<EnvSnapshot>;
}

// 인라인/원격 회수 본문을 EnvSnapshot 으로 검증 — 형식 불일치는 침묵 대신 명확히 실패(외부 계약 오류 → run 실패).
function parseSnapshot(raw: unknown, label: string): EnvSnapshot {
  const parsed = EnvSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError(
      "HARNESS_RUN_FAILED",
      { label, issues: parsed.error.issues.map((i) => i.message) },
      `${label} 이 EnvSnapshot 형식이 아닙니다.`,
    );
  }
  return parsed.data;
}

// reference(store-fetch): 타깃이 있으면 그 스냅샷을 pull, 없으면 prompt. 현행 service-backend 관측 스텝과 동일.
export const referenceObservationSource: ObservationSource = {
  async observe({ target }) {
    return target ? target.snapshot() : { kind: "prompt", output: "" };
  },
};

// sentinel(반환 채널): 에이전트가 front-door 응답으로 인라인 반환한 관측물을 꺼낸다. path 가 있으면 dot-path 로,
// 없으면 본문 전체를 EnvSnapshot 으로 본다.
export function sentinelObservationSource(path: string | undefined): ObservationSource {
  return {
    async observe({ response }) {
      const raw = path ? getField(response, path) : response;
      return parseSnapshot(raw, `sentinel 관측물(${path ?? "응답 본문"})`);
    },
  };
}

// egress(push-to-sink): 에이전트가 관측물을 sink 로 밀어넣고, 평가는 그 sink 에서 회수한다. sink 는 {run_id} 보간 URL
// — getJson 으로 GET 후 EnvSnapshot 검증. (Everdict 가 프로비저닝한 타깃 pull 이 아니라 에이전트가 보낸 위치에서 읽음.)
export function egressObservationSource(sink: string): ObservationSource {
  return {
    async observe({ getJson, wiring }) {
      if (!getJson) {
        throw new InternalError("HARNESS_RUN_FAILED", { sink }, "egress 회수에 필요한 fetch 프리미티브가 없습니다.");
      }
      const url = interpolatePath(sink, wiring ?? {});
      return parseSnapshot(await getJson(url), `egress 관측물(${url})`);
    },
  };
}

// delivery → 회수 전략. 미설정/reference + sentinel + egress 모두 구현. 알 수 없는 모드는 스키마(discriminatedUnion)가
// 경계에서 거른다 — 여기까지 오면 셋 중 하나.
export function observationSourceFor(delivery: ObservationDelivery | undefined): ObservationSource {
  if (!delivery || delivery.mode === "reference") return referenceObservationSource;
  if (delivery.mode === "sentinel") return sentinelObservationSource(delivery.path);
  return egressObservationSource(delivery.sink);
}
