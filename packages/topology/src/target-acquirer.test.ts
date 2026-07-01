import type { ServiceHarnessSpec, TargetAcquire, TopologyTarget } from "@assay/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AcquireRequestFn,
  type ProbeFn,
  fetchAcquire,
  serviceAcquirer,
  targetAcquirerFor,
} from "./target-acquirer.js";
import type { TopologyRuntime } from "./topology-runtime.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "t",
  version: "1",
  services: [{ name: "browsers", image: "img", port: 7000, needs: [], perRun: [], replicas: 1, env: {} }],
  dependencies: [],
  frontDoor: { service: "browsers", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m" },
};

// 호출을 기록하고 method+url 키로 응답을 돌려주는 가짜 HTTP 프리미티브.
function fakeRequest(responses: Record<string, unknown>): {
  fn: AcquireRequestFn;
  calls: Array<{ method: string; url: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fn: AcquireRequestFn = async (method, url, body) => {
    calls.push({ method, url, body });
    return responses[`${method} ${url}`] ?? {};
  };
  return { fn, calls };
}

const SERVICE_ACQUIRE: Extract<TargetAcquire, { mode: "service" }> = {
  mode: "service",
  service: "browsers",
  open: "POST /sessions",
  coordinates: { session_id: "id", target_cdp_url: "cdp_url" },
  close: "DELETE /sessions/{session_id}",
};

describe("serviceAcquirer", () => {
  it("세션을 열어 응답 필드를 wiring 좌표로 매핑하고, dispose 시 session_id 로 close 한다", async () => {
    const { fn, calls } = fakeRequest({
      "POST http://browsers:7000/sessions": { id: "sess-7", cdp_url: "ws://x/7" },
    });
    const acq = serviceAcquirer(SERVICE_ACQUIRE, fn);

    const handle = await acq.acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://browsers:7000" },
      wiring: { run_id: "r1" },
    });

    // 단일 cdpUrl 이 아니라 좌표 bag — 세션형 좌표가 모두 wiring 으로.
    expect(handle.wiring).toEqual({ session_id: "sess-7", target_cdp_url: "ws://x/7" });
    // Assay 소유 무대 없음 → snapshot 은 prompt(실 관측은 delivery 로).
    expect((await handle.snapshot()).kind).toBe("prompt");

    await handle.dispose();
    // close 는 좌표(session_id)로 보간된 경로로 DELETE.
    expect(calls).toContainEqual({ method: "DELETE", url: "http://browsers:7000/sessions/sess-7", body: undefined });
  });

  it("좌표 누락은 명확히 실패하되, 이미 받은 좌표로 best-effort close 한다(세션 누수 방지)", async () => {
    // 응답에 cdp_url 없음 → session_id 는 받고 target_cdp_url 매핑에서 throw.
    const { fn, calls } = fakeRequest({ "POST http://browsers:7000/sessions": { id: "sess-7" } });
    const acq = serviceAcquirer(SERVICE_ACQUIRE, fn);

    await expect(
      acq.acquire({
        spec: SPEC,
        runId: "r1",
        endpoints: { browsers: "http://browsers:7000" },
        wiring: { run_id: "r1" },
      }),
    ).rejects.toThrow();

    // 열린 세션을 흘리지 않는다 — session_id 를 받았으므로 close 가능.
    expect(calls.some((c) => c.method === "DELETE" && c.url === "http://browsers:7000/sessions/sess-7")).toBe(true);
  });

  it("타깃 서비스 엔드포인트가 없으면 실패한다", async () => {
    const acq = serviceAcquirer(SERVICE_ACQUIRE, async () => ({}));
    await expect(acq.acquire({ spec: SPEC, runId: "r1", endpoints: {}, wiring: {} })).rejects.toThrow(/엔드포인트/);
  });

  // --- 준비 게이트(ready): 세션 클라이언트가 자기등록하기 전엔 명령이 404 로 튕기므로 200 될 때까지 대기 ---
  const WITH_READY: Extract<TargetAcquire, { mode: "service" }> = {
    ...SERVICE_ACQUIRE,
    ready: { service: "browsers", poll: "GET /sessions/{session_id}/ready", intervalMs: 10, timeoutMs: 1000 },
  };

  it("ready: 상태 URL 이 200 될 때까지 폴링한 뒤에야 좌표를 넘긴다(좌표로 보간된 경로)", async () => {
    const { fn } = fakeRequest({ "POST http://browsers:7000/sessions": { id: "sess-7", cdp_url: "ws://x/7" } });
    let probes = 0;
    const probedUrls: string[] = [];
    const probe: ProbeFn = async (_method, url) => {
      probes += 1;
      probedUrls.push(url);
      return probes >= 3; // 처음 2회는 아직 안 준비(404), 3회째 200
    };
    const acq = serviceAcquirer(WITH_READY, fn, { probe, now: () => 0, sleep: async () => {} });

    const handle = await acq.acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://browsers:7000" },
      wiring: { run_id: "r1" },
    });

    expect(probes).toBe(3);
    // poll 경로가 좌표(session_id)로 보간됐다.
    expect(probedUrls[0]).toBe("http://browsers:7000/sessions/sess-7/ready");
    expect(handle.wiring).toEqual({ session_id: "sess-7", target_cdp_url: "ws://x/7" });
  });

  it("ready: 시한 초과면 열린 세션을 close 하고 실패한다(누수 방지)", async () => {
    const { fn, calls } = fakeRequest({ "POST http://browsers:7000/sessions": { id: "sess-7", cdp_url: "ws://x/7" } });
    const probe: ProbeFn = async () => false; // 영영 준비 안 됨
    let t = 0;
    const acq = serviceAcquirer(
      { ...SERVICE_ACQUIRE, ready: { service: "browsers", poll: "GET /ready", intervalMs: 10, timeoutMs: 30 } },
      fn,
      {
        probe,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );

    await expect(
      acq.acquire({
        spec: SPEC,
        runId: "r1",
        endpoints: { browsers: "http://browsers:7000" },
        wiring: { run_id: "r1" },
      }),
    ).rejects.toThrow(/준비 대기 시간초과/);
    // 열린 세션을 흘리지 않는다 — 좌표(session_id)로 close.
    expect(calls.some((c) => c.method === "DELETE" && c.url === "http://browsers:7000/sessions/sess-7")).toBe(true);
  });
});

describe("fetchAcquire", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // method+init 을 기록하고 빈 JSON 을 돌려주는 fetch 스텁.
  function stubFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { json: async () => ({}) } as Response;
    });
    return { calls };
  }

  it("본문 없는 POST 는 빈 {} JSON 본문 + content-type 으로 보낸다(JSON 요구 서버의 422 방지)", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("POST", "http://s/sessions");
    expect(calls[0]?.init.body).toBe("{}");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("소문자 post 도 동일하게 빈 {} 를 보낸다(메서드 대소문자 무관)", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("post", "http://s/sessions");
    expect(calls[0]?.init.body).toBe("{}");
  });

  it("GET/DELETE 는 본문을 주입하지 않는다(content-type 없이)", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("GET", "http://s/x");
    await fetchAcquire("DELETE", "http://s/sessions/1");
    expect(calls[0]?.init.body).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(calls[1]?.init.body).toBeUndefined();
  });

  it("명시 본문이 있으면 POST 든 무엇이든 그대로 직렬화해 보낸다", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("POST", "http://s/sessions", { task: "t" });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ task: "t" }));
  });
});

describe("targetAcquirerFor", () => {
  it("acquire 미설정(provision)이면 런타임 provisionBrowserEnv 로 위임한다(현행)", async () => {
    let provisioned = false;
    const runtime: TopologyRuntime = {
      id: "fake",
      async ensureTopology() {
        return { endpoints: {} };
      },
      async provisionBrowserEnv() {
        provisioned = true;
        return {
          wiring: { target_cdp_url: "ws://provisioned" },
          async snapshot() {
            return { kind: "prompt", output: "" };
          },
          async dispose() {},
        };
      },
    };
    const target: TopologyTarget = {
      kind: "browser",
      engine: "chromium",
      lifecycle: "per-case-instance",
      observe: ["dom"],
    };

    const handle = await targetAcquirerFor(target, runtime).acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: {},
      wiring: {},
    });

    expect(provisioned).toBe(true);
    expect(handle.wiring.target_cdp_url).toBe("ws://provisioned");
  });
});
