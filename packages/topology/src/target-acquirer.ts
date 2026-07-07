import {
  InternalError,
  type ServiceHarnessSpec,
  type TargetAcquire,
  type TopologyTarget,
  type TrustZone,
  UpstreamError,
} from "@everdict/core";
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

// 준비성 probe — 상태 URL 이 200(2xx)이면 준비됨. 세션 클라이언트가 아직 back-connect 안 했으면 404 등.
export type ProbeFn = (method: string, url: string) => Promise<boolean>;

export const fetchProbe: ProbeFn = async (method, url) => {
  try {
    const res = await fetch(url, { method, headers: { accept: "application/json" } });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false; // 연결 거부/네트워크 오류 = 아직 안 준비
  }
};

// serviceAcquirer 의 주입형 IO — 기본은 실제 fetch probe + 실시간 시계(테스트는 가짜 주입으로 결정적 폴링).
export interface ServiceAcquirerIo {
  probe?: ProbeFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const fetchAcquire: AcquireRequestFn = async (method, url, body) => {
  // 본문 없는 POST(예: 파라미터 없는 세션 open)는 빈 {} 를 실어 보낸다 — JSON 본문을 요구하는 서버가 본문 없는
  // POST 를 422 로 거부하는 걸 막는다. GET/DELETE 는 그대로 본문 없이(누가 명시 본문을 주면 그건 존중).
  const sendBody = body === undefined && method.toUpperCase() === "POST" ? {} : body;
  const res = await fetch(url, {
    method,
    headers:
      sendBody !== undefined
        ? { "content-type": "application/json", accept: "application/json" }
        : { accept: "application/json" },
    ...(sendBody !== undefined ? { body: JSON.stringify(sendBody) } : {}),
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

// service: 선언된 서비스의 세션 API 를 열어 좌표 bag 을 받는다. Everdict 가 무대를 소유하지 않으므로(컨테이너 없음)
// 관측은 delivery(sentinel/egress)로 — 자체 snapshot 은 prompt(무대 없음) fallback. front-door driver 의 미러(타깃판):
// open=submit, coordinates=correlate(단일 id 가 아닌 좌표 bag), close=lifecycle teardown.
export function serviceAcquirer(
  acquire: Extract<TargetAcquire, { mode: "service" }>,
  request: AcquireRequestFn,
  io: ServiceAcquirerIo = {},
): TargetAcquirer {
  const probe = io.probe ?? fetchProbe;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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

      // 준비 게이트: 세션은 열렸으나 그 클라이언트(브라우저 등)가 back-connect 로 자기등록하기 전엔 front-door 명령이
      // 404 로 튕긴다. ready 가 있으면 상태 URL 이 200 될 때까지 폴링 — 시한 초과면 열린 세션을 흘리지 않게 close 후 실패.
      if (acquire.ready) {
        const ready = acquire.ready;
        const readyBase = endpoints[ready.service ?? acquire.service];
        if (!readyBase) {
          await closeSession(request, base, acquire.close, closeWiring).catch(() => {});
          throw new InternalError(
            "HARNESS_RUN_FAILED",
            { service: ready.service ?? acquire.service },
            "준비성 확인 서비스 엔드포인트가 없습니다.",
          );
        }
        const rp = methodPath(ready.poll);
        const readyUrl = joinUrl(readyBase, interpolatePath(rp.path, closeWiring)); // {session_id} 등 좌표 보간
        const start = now();
        let isReady = false;
        while (now() - start < ready.timeoutMs) {
          let ok = false;
          try {
            ok = await probe(rp.method, readyUrl);
          } catch {
            ok = false; // probe throw = 아직 안 준비 → 재시도
          }
          if (ok) {
            isReady = true;
            break;
          }
          await sleep(ready.intervalMs);
        }
        if (!isReady) {
          await closeSession(request, base, acquire.close, closeWiring).catch(() => {});
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { url: readyUrl, timeoutMs: ready.timeoutMs },
            "타깃 세션 준비 대기 시간초과",
          );
        }
      }

      return {
        wiring: coords,
        async snapshot() {
          return { kind: "prompt", output: "" }; // Everdict 소유 무대 없음 — 실 관측은 delivery(sentinel/egress)로 전달.
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
  io: ServiceAcquirerIo = {},
): TargetAcquirer {
  if (target.acquire?.mode === "service") return serviceAcquirer(target.acquire, request, io);
  return provisionAcquirer(runtime);
}
