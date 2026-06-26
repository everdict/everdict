import {
  InternalError,
  type ServiceHarnessSpec,
  type TargetAcquire,
  type TopologyTarget,
  type TrustZone,
  UpstreamError,
} from "@assay/core";
import { getField, interpolatePath, joinUrl, methodPath } from "./front-door-driver.js";
import type { TargetEnvHandle, TopologyRuntime } from "./topology-runtime.js";

// 타깃 획득(WHAT-target) 추상화 — TopologyRuntime(WHERE)/FrontDoorDriver(HOW-drive)/ObservationSource(HOW-observe)의
// 네 번째 형제. per-case 타깃 환경을 "어떻게 손에 넣는가"를 전략으로 분리한다:
//   provision(기본) — 런타임이 per-case 브라우저 컨테이너를 띄운다(현행 provisionBrowserEnv).
//   service          — 선언된 토폴로지 서비스의 세션 API 를 열어(open) 좌표를 wiring 으로 받고(coordinates) dispose 시 close.
// 설계: docs/architecture/target-acquisition-generalization.md.

export interface AcquireRequest {
  spec: ServiceHarnessSpec;
  runId: string;
  endpoints: Record<string, string>; // warm 토폴로지 서비스 → 베이스 URL (세션 서비스 도달)
  wiring: Record<string, string>; // open/close path 보간(run_id + isolateBy 파생 + task). 좌표는 close 시 추가 머지.
  zone?: TrustZone;
}

export interface TargetAcquirer {
  acquire(req: AcquireRequest): Promise<TargetEnvHandle>;
}

// 메서드-인지 HTTP 프리미티브 — open(POST/GET)·close(DELETE)를 일반적으로 다룬다(submit/getJson 은 POST/GET 전용).
// 테스트에서 주입. 응답이 JSON 이 아니거나 비어도 관용 파싱(좌표가 없으면 매핑 단계에서 명확히 실패).
export type AcquireRequestFn = (method: string, url: string, body?: unknown) => Promise<unknown>;

export const fetchAcquire: AcquireRequestFn = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers:
      body !== undefined
        ? { "content-type": "application/json", accept: "application/json" }
        : { accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    return await res.json();
  } catch {
    return undefined;
  }
};

// provision(기본): 런타임이 per-case 브라우저를 띄운다 — 현행 동작 그대로(핸들 wiring = { target_cdp_url }).
export function provisionAcquirer(runtime: TopologyRuntime): TargetAcquirer {
  return {
    async acquire({ spec, runId, zone }) {
      return runtime.provisionBrowserEnv(spec, runId, zone);
    },
  };
}

// service: 선언된 서비스의 세션 API 를 열어 좌표 bag 을 받는다. Assay 가 무대를 소유하지 않으므로(컨테이너 없음)
// 관측은 delivery(sentinel/egress)로 — 자체 snapshot 은 prompt(무대 없음) fallback. front-door driver 의 미러(타깃판):
// open=submit, coordinates=correlate(단일 id 가 아닌 좌표 bag), close=lifecycle teardown.
export function serviceAcquirer(
  acquire: Extract<TargetAcquire, { mode: "service" }>,
  request: AcquireRequestFn,
): TargetAcquirer {
  return {
    async acquire({ endpoints, wiring }) {
      const base = endpoints[acquire.service];
      if (!base) {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { service: acquire.service },
          "타깃 세션 서비스 엔드포인트가 없습니다.",
        );
      }
      const open = methodPath(acquire.open);
      const res = await request(open.method, joinUrl(base, interpolatePath(open.path, wiring)));

      // 좌표 매핑: open 응답의 dot-path → wiring 변수. 누락/형식불일치는 침묵 대신 명확히 실패(외부 계약 오류).
      const coords: Record<string, string> = {};
      try {
        for (const [name, path] of Object.entries(acquire.coordinates)) {
          const value = getField(res, path);
          if (typeof value !== "string" || value === "") {
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { name, path, got: value },
              `세션 개시 응답에서 좌표(${name} ← ${path})를 찾지 못했습니다.`,
            );
          }
          coords[name] = value;
        }
      } catch (err) {
        // 세션은 열렸는데 좌표 매핑 실패 — 누수 방지로 지금까지 받은 좌표로 best-effort close 후 rethrow(#6 와 같은 규율).
        await closeSession(request, base, acquire.close, { ...wiring, ...coords }).catch(() => {});
        throw err;
      }

      const closeWiring = { ...wiring, ...coords };
      return {
        wiring: coords,
        async snapshot() {
          return { kind: "prompt", output: "" }; // Assay 소유 무대 없음 — 실 관측은 delivery(sentinel/egress)로 전달.
        },
        async dispose() {
          await closeSession(request, base, acquire.close, closeWiring).catch(() => {});
        },
      };
    },
  };
}

async function closeSession(
  request: AcquireRequestFn,
  base: string,
  close: string | undefined,
  wiring: Record<string, string>,
): Promise<void> {
  if (!close) return;
  const c = methodPath(close);
  await request(c.method, joinUrl(base, interpolatePath(c.path, wiring)));
}

// target.acquire → 획득 전략. 미설정/provision = 런타임 프로비전(현행), service = 세션 API 획득.
// 알 수 없는 mode 는 스키마(discriminatedUnion)가 경계에서 거른다.
export function targetAcquirerFor(
  target: TopologyTarget,
  runtime: TopologyRuntime,
  request: AcquireRequestFn = fetchAcquire,
): TargetAcquirer {
  if (target.acquire?.mode === "service") return serviceAcquirer(target.acquire, request);
  return provisionAcquirer(runtime);
}
