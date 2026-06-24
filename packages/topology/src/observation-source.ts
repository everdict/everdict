import { type EnvSnapshot, InternalError, type ObservationDelivery } from "@assay/core";

// 관측물(observation/관측물) 회수 추상화 — TopologyRuntime(WHERE)/FrontDoorDriver(HOW-drive) 의 형제(HOW-observe).
// delivery.mode 별로 관측물이 grader/judge 에 도달하는 경로가 다르다:
//   reference — 평가가 store(브라우저 CDP 등)에서 pull (현행, 무회귀). store-locality(co-locate)와 짝.
//   sentinel  — 실행이 결과 채널로 인라인 반환 (슬라이스 3). store hop 없음 — 작은 관측물에 유리.
//   egress    — 실행이 sink 로 push (슬라이스 4). judge 가 멀 때 pull 대신 push.
// 설계: docs/architecture/judge-placement-locality.md.

// per-case 타깃의 관측 표면만(snapshot) — provisionBrowserEnv 핸들이 구조적으로 만족한다. 런타임 결합 최소화.
export interface ObservationTarget {
  snapshot(): Promise<EnvSnapshot>;
}

export interface ObserveRequest {
  target: ObservationTarget | undefined; // 무대 없으면 undefined → prompt 스냅샷(1차 신호 = trace)
}

export interface ObservationSource {
  observe(req: ObserveRequest): Promise<EnvSnapshot>;
}

// reference(store-fetch): 타깃이 있으면 그 스냅샷을 pull, 없으면 prompt. 현행 service-backend 관측 스텝과 동일.
export const referenceObservationSource: ObservationSource = {
  async observe({ target }) {
    return target ? target.snapshot() : { kind: "prompt", output: "" };
  },
};

type ObservationDeliveryMode = ObservationDelivery["mode"];

// delivery.mode → 회수 전략. 미설정/reference 만 구현(슬라이스 2). sentinel/egress 는 후속 슬라이스에서 채운다 —
// 침묵 폴백 없이 명시적으로 실패시켜 "선언했지만 동작 안 함"을 가시화한다(디스패치의 try/catch 가 run 실패로 기록).
export function observationSourceFor(mode: ObservationDeliveryMode): ObservationSource {
  if (mode === "reference") return referenceObservationSource;
  throw new InternalError(
    "HARNESS_RUN_FAILED",
    { mode },
    `관측물 전달 모드 '${mode}' 는 아직 구현되지 않았습니다(현재 reference 만 지원).`,
  );
}
