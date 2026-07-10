import type { ServiceHarnessSpec, TargetAcquire, TopologyTarget } from "@everdict/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopologyRuntime } from "../deploy/topology-runtime.js";
import {
  type AcquireRequestFn,
  type ProbeFn,
  fetchAcquire,
  serviceAcquirer,
  targetAcquirerFor,
} from "./target-acquirer.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "t",
  version: "1",
  services: [{ name: "browsers", image: "img", port: 7000, needs: [], perRun: [], replicas: 1, env: {} }],
  dependencies: [],
  frontDoor: { service: "browsers", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m" },
};

// A fake HTTP primitive that records calls and returns responses keyed by method+url.
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
  it("opens a session, maps response fields to wiring coordinates, and closes by session_id on dispose", async () => {
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

    // A coordinate bag, not a single cdpUrl — all session coordinates become wiring.
    expect(handle.wiring).toEqual({ session_id: "sess-7", target_cdp_url: "ws://x/7" });
    // No Everdict-owned stage → snapshot is prompt (the real observation goes via delivery).
    expect((await handle.snapshot()).kind).toBe("prompt");

    await handle.dispose();
    // close DELETEs the path interpolated with the coordinate (session_id).
    expect(calls).toContainEqual({ method: "DELETE", url: "http://browsers:7000/sessions/sess-7", body: undefined });
  });

  it("a missing coordinate fails explicitly but best-effort closes with the coordinates already received (avoid session leak)", async () => {
    // No cdp_url in the response → session_id is received but the target_cdp_url mapping throws.
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

    // Don't leak the open session — session_id was received, so it can be closed.
    expect(calls.some((c) => c.method === "DELETE" && c.url === "http://browsers:7000/sessions/sess-7")).toBe(true);
  });

  it("fails when there's no target service endpoint", async () => {
    const acq = serviceAcquirer(SERVICE_ACQUIRE, async () => ({}));
    await expect(acq.acquire({ spec: SPEC, runId: "r1", endpoints: {}, wiring: {} })).rejects.toThrow(/endpoint/);
  });

  // --- Readiness gate (ready): until the session client self-registers, commands bounce with 404, so wait until 200 ---
  const WITH_READY: Extract<TargetAcquire, { mode: "service" }> = {
    ...SERVICE_ACQUIRE,
    ready: { service: "browsers", poll: "GET /sessions/{session_id}/ready", intervalMs: 10, timeoutMs: 1000 },
  };

  it("ready: hands back coordinates only after polling the status URL until 200 (coordinate-interpolated path)", async () => {
    const { fn } = fakeRequest({ "POST http://browsers:7000/sessions": { id: "sess-7", cdp_url: "ws://x/7" } });
    let probes = 0;
    const probedUrls: string[] = [];
    const probe: ProbeFn = async (_method, url) => {
      probes += 1;
      probedUrls.push(url);
      return probes >= 3; // first 2 not ready yet (404), 200 on the 3rd
    };
    const acq = serviceAcquirer(WITH_READY, fn, { probe, now: () => 0, sleep: async () => {} });

    const handle = await acq.acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://browsers:7000" },
      wiring: { run_id: "r1" },
    });

    expect(probes).toBe(3);
    // the poll path was interpolated with the coordinate (session_id).
    expect(probedUrls[0]).toBe("http://browsers:7000/sessions/sess-7/ready");
    expect(handle.wiring).toEqual({ session_id: "sess-7", target_cdp_url: "ws://x/7" });
  });

  it("ready: on timeout, closes the open session and fails (leak prevention)", async () => {
    const { fn, calls } = fakeRequest({ "POST http://browsers:7000/sessions": { id: "sess-7", cdp_url: "ws://x/7" } });
    const probe: ProbeFn = async () => false; // never becomes ready
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
    ).rejects.toThrow(/Timed out waiting for the target session/);
    // Don't leak the open session — close by the coordinate (session_id).
    expect(calls.some((c) => c.method === "DELETE" && c.url === "http://browsers:7000/sessions/sess-7")).toBe(true);
  });
});

describe("fetchAcquire", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A fetch stub that records method+init and returns empty JSON.
  function stubFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { json: async () => ({}) } as Response;
    });
    return { calls };
  }

  it("a bodyless POST is sent with an empty {} JSON body + content-type (prevents 422 from a JSON-requiring server)", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("POST", "http://s/sessions");
    expect(calls[0]?.init.body).toBe("{}");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("lowercase post also sends an empty {} (method is case-insensitive)", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("post", "http://s/sessions");
    expect(calls[0]?.init.body).toBe("{}");
  });

  it("GET/DELETE inject no body (without content-type)", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("GET", "http://s/x");
    await fetchAcquire("DELETE", "http://s/sessions/1");
    expect(calls[0]?.init.body).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(calls[1]?.init.body).toBeUndefined();
  });

  it("with an explicit body, serializes and sends it as-is for POST or anything", async () => {
    const { calls } = stubFetch();
    await fetchAcquire("POST", "http://s/sessions", { task: "t" });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ task: "t" }));
  });
});

describe("targetAcquirerFor", () => {
  it("delegates to the runtime's provisionBrowserEnv when acquire is unset (provision) (current)", async () => {
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
