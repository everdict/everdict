import { type EnvSnapshot, EnvSnapshotSchema, InternalError, type ObservationDelivery } from "@assay/core";
import { getField } from "./front-door-driver.js";

// 관측물(observation/관측물) 회수 추상화 — TopologyRuntime(WHERE)/FrontDoorDriver(HOW-drive) 의 형제(HOW-observe).
// delivery.mode 별로 관측물이 grader/judge 에 도달하는 경로가 다르다:
//   reference — 평가가 store(브라우저 CDP 등)에서 pull (현행, 무회귀). store-locality(co-locate)와 짝.
//   sentinel  — 실행이 결과 채널(front-door 응답)로 인라인 반환 (슬라이스 3). store hop 없음 — 작은 관측물에 유리.
//   egress    — 실행이 sink 로 push (슬라이스 4). judge 가 멀 때 pull 대신 push.
// 설계: docs/architecture/judge-placement-locality.md.

// per-case 타깃의 관측 표면만(snapshot) — provisionBrowserEnv 핸들이 구조적으로 만족한다. 런타임 결합 최소화.
export interface ObservationTarget {
  snapshot(): Promise<EnvSnapshot>;
}

export interface ObserveRequest {
  target: ObservationTarget | undefined; // 무대 없으면 undefined → reference 는 prompt 스냅샷
  response?: unknown; // 결과 채널 본문(DriveOutcome.response) — sentinel 이 여기서 관측물을 추출
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

// sentinel(반환 채널): 에이전트가 front-door 응답으로 인라인 반환한 관측물을 꺼낸다. path 가 있으면 dot-path 로,
// 없으면 본문 전체를 EnvSnapshot 으로 본다. 형식 불일치는 침묵 대신 명확히 실패(외부 계약 오류 → run 실패).
export function sentinelObservationSource(path: string | undefined): ObservationSource {
  return {
    async observe({ response }) {
      const raw = path ? getField(response, path) : response;
      const parsed = EnvSnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { path, issues: parsed.error.issues.map((i) => i.message) },
          `sentinel 관측물(${path ?? "응답 본문"})이 EnvSnapshot 형식이 아닙니다.`,
        );
      }
      return parsed.data;
    },
  };
}

// delivery → 회수 전략. 미설정/reference + sentinel 구현(슬라이스 2-3). egress 는 후속(슬라이스 4) — 침묵 폴백 없이
// 명시적으로 throw 해 "선언했지만 동작 안 함"을 가시화한다(디스패치 try/catch 가 run 실패로 기록).
export function observationSourceFor(delivery: ObservationDelivery | undefined): ObservationSource {
  if (!delivery || delivery.mode === "reference") return referenceObservationSource;
  if (delivery.mode === "sentinel") return sentinelObservationSource(delivery.path);
  throw new InternalError(
    "HARNESS_RUN_FAILED",
    { mode: delivery.mode },
    `관측물 전달 모드 '${delivery.mode}' 는 아직 구현되지 않았습니다(reference/sentinel 지원).`,
  );
}
