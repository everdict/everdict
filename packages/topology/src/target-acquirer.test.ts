import type { ServiceHarnessSpec, TargetAcquire, TopologyTarget } from "@assay/core";
import { describe, expect, it } from "vitest";
import { type AcquireRequestFn, serviceAcquirer, targetAcquirerFor } from "./target-acquirer.js";
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
