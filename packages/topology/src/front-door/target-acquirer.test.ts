import {
  BadRequestError,
  type ServiceHarnessSpec,
  type TargetAcquire,
  type TopologyTarget,
  UpstreamError,
} from "@everdict/contracts";
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

  it("exposes the session's own CDP base when the spec declares where to read it", async () => {
    const { fn } = fakeRequest({
      "POST http://browsers:7000/sessions": {
        id: "sess-7",
        cdp_url: "ws://internal/7",
        observe: { cdp: "http://h:31" },
      },
    });
    const acq = serviceAcquirer({ ...SERVICE_ACQUIRE, cdpBase: "observe.cdp" }, fn);

    const handle = await acq.acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://browsers:7000" },
      wiring: { run_id: "r1" },
    });

    // The observation address is deliberately NOT the agent-facing coordinate — that one is an internal alias.
    expect(handle.cdpBase).toBe("http://h:31");
    expect(handle.wiring.target_cdp_url).toBe("ws://internal/7");
  });

  it("acquires the session anyway when the declared CDP base is missing — observability never fails an eval", async () => {
    const { fn } = fakeRequest({
      "POST http://browsers:7000/sessions": { id: "sess-7", cdp_url: "ws://internal/7" },
    });
    const acq = serviceAcquirer({ ...SERVICE_ACQUIRE, cdpBase: "observe.cdp" }, fn);

    const handle = await acq.acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://browsers:7000" },
      wiring: { run_id: "r1" },
    });

    expect(handle.cdpBase).toBeUndefined();
    expect(handle.wiring.session_id).toBe("sess-7"); // the case still runs
  });
});

describe("fetchAcquire", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A fetch stub that records method+init and returns empty JSON (2xx).
  function stubFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => "{}" } as Response;
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

  it("a non-2xx session-open surfaces the HTTP status + body instead of flowing into coordinate mapping", async () => {
    // Given the session service rejects the open with a 422 validation body
    vi.stubGlobal("fetch", async () => {
      return {
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ detail: [{ loc: ["body", "session_ids"], msg: "field required" }] }),
      } as Response;
    });
    // When/Then the request fails with the real cause (HTTP 422 + body) — pre-fix the error body was returned
    // as a normal value and the caller misreported it as "no value at session_ids.0".
    await expect(fetchAcquire("POST", "http://s/sessions")).rejects.toThrow(/HTTP 422.*field required/s);
  });

  it("a network failure opening the session is remapped to UpstreamError (no raw fetch error across the boundary)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    await expect(fetchAcquire("POST", "http://s/sessions")).rejects.toThrow(/session request failed: .*ECONNREFUSED/);
  });

  it("a non-JSON 2xx body degrades to undefined (a missing coordinate then fails at the mapping step)", async () => {
    vi.stubGlobal("fetch", async () => {
      return { ok: true, status: 204, text: async () => "" } as Response;
    });
    await expect(fetchAcquire("DELETE", "http://s/sessions/1")).resolves.toBeUndefined();
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

describe("serviceAcquirer — waiting out a full session pool", () => {
  // The real transport throws an UpstreamError, whose payload lives on `extra` — a fake that used a different
  // shape is exactly how the pool-full path shipped unrecognised.
  const full = () => new UpstreamError("UPSTREAM_ERROR", { status: 409 }, "session request failed: HTTP 409 pool full");

  function refusingRequest(refusals: number): { fn: AcquireRequestFn; opens: number } {
    const state = { opens: 0 };
    const fn: AcquireRequestFn = async (method) => {
      if (method !== "POST") return {};
      state.opens += 1;
      if (state.opens <= refusals) throw full();
      return { id: "sess-1" };
    };
    return {
      fn,
      get opens() {
        return state.opens;
      },
    };
  }

  const WAITING: Extract<TargetAcquire, { mode: "service" }> = {
    ...SERVICE_ACQUIRE,
    coordinates: { session_id: "id" },
    wait: { statuses: [409, 429], timeoutMs: 10_000, intervalMs: 10 },
  };

  it("retries a full pool until a session frees up — a batch wider than the pool queues instead of failing", async () => {
    const req = refusingRequest(3);
    let clock = 0;
    const acq = serviceAcquirer(WAITING, req.fn, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    const handle = await acq.acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://browsers:7000" },
      wiring: { run_id: "r1" },
    });

    expect(handle.wiring.session_id).toBe("sess-1");
    expect(req.opens).toBe(4); // three refusals waited out, the fourth admitted
  });

  it("gives up at the deadline and surfaces the service's own refusal", async () => {
    const req = refusingRequest(Number.POSITIVE_INFINITY);
    let clock = 0;
    const acq = serviceAcquirer({ ...WAITING, wait: { statuses: [409], timeoutMs: 50, intervalMs: 10 } }, req.fn, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    // The real error, not a synthetic timeout — it still carries what the service said.
    await expect(
      acq.acquire({ spec: SPEC, runId: "r1", endpoints: { browsers: "http://browsers:7000" }, wiring: {} }),
    ).rejects.toThrow(/pool full/);
  });

  it("never waits on a refusal that is not about capacity", async () => {
    const bad: AcquireRequestFn = async () => {
      throw new UpstreamError("UPSTREAM_ERROR", { status: 400 }, "bad request");
    };
    let slept = 0;
    const acq = serviceAcquirer(WAITING, bad, {
      now: () => 0,
      sleep: async () => {
        slept += 1;
      },
    });

    // Waiting on a 400 would turn a clear authoring error into a two-minute timeout.
    await expect(
      acq.acquire({ spec: SPEC, runId: "r1", endpoints: { browsers: "http://browsers:7000" }, wiring: {} }),
    ).rejects.toThrow(/bad request/);
    expect(slept).toBe(0);
  });
});

describe("serviceAcquirer — wait without schema defaults applied", () => {
  it("still recognises a full pool when the spec never went through the schema (inline / injected specs)", async () => {
    // Depending on a Zod default having been applied turns a missing field into a crash inside error handling —
    // which is how a declared wait produced "Cannot read properties of undefined" instead of queueing.
    let opens = 0;
    const request: AcquireRequestFn = async (method) => {
      if (method !== "POST") return {};
      opens += 1;
      if (opens === 1) throw new UpstreamError("UPSTREAM_ERROR", { status: 409 }, "pool full");
      return { id: "sess-1" };
    };
    let clock = 0;
    const acq = serviceAcquirer(
      {
        ...SERVICE_ACQUIRE,
        coordinates: { session_id: "id" },
        wait: { timeoutMs: 5_000 } as Extract<TargetAcquire, { mode: "service" }>["wait"],
      },
      request,
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );

    const handle = await acq.acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://browsers:7000" },
      wiring: {},
    });
    expect(handle.wiring.session_id).toBe("sess-1");
    expect(opens).toBe(2);
  });
});

// ── A TARGET THAT IS NOT A BROWSER (docs/architecture/harness-definability-spec.md §1) ─────────────────
describe("targetAcquirerFor — api and os targets", () => {
  // A runtime that provisions a BROWSER when asked; an api or os target must never reach it.
  const browserOnlyRuntime: TopologyRuntime = {
    id: "fake",
    async ensureTopology() {
      return { endpoints: {} };
    },
    async provisionBrowserEnv() {
      throw new Error("an api or os target must not provision a browser");
    },
  };
  it("a static api target hands the agent its base URL as `target_base_url`, provisioning nothing", async () => {
    const target: TopologyTarget = { kind: "api", baseUrl: "https://shop.internal", observe: ["request", "response"] };
    const handle = await targetAcquirerFor(target, browserOnlyRuntime).acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: {},
      wiring: {},
    });
    expect(handle.wiring.target_base_url).toBe("https://shop.internal");
    await handle.dispose();
  });
  it("an api target with neither baseUrl nor a session API, and any os target without one, are refused by name rather than provisioned", () => {
    const api: TopologyTarget = { kind: "api", observe: ["request", "response"] };
    expect(() => targetAcquirerFor(api, browserOnlyRuntime)).toThrow(BadRequestError);
    expect(() => targetAcquirerFor(api, browserOnlyRuntime)).toThrow(/baseUrl/);
    const os: TopologyTarget = { kind: "os", os: "linux", observe: ["screenshot", "window"] };
    expect(() => targetAcquirerFor(os, browserOnlyRuntime)).toThrow(BadRequestError);
    expect(() => targetAcquirerFor(os, browserOnlyRuntime)).toThrow(/desktop/);
  });
  it("an api or os target acquired through a session API takes the service acquirer, like a browser", async () => {
    const acquire: TargetAcquire = {
      mode: "service",
      service: "browsers",
      open: "POST /sessions",
      coordinates: { target_base_url: "url" },
    };
    const { fn } = fakeRequest({ "POST http://b/sessions": { url: "https://tenant-42.shop.internal" } });
    const target: TopologyTarget = { kind: "api", acquire, observe: ["request"] };
    const handle = await targetAcquirerFor(target, browserOnlyRuntime, fn).acquire({
      spec: SPEC,
      runId: "r1",
      endpoints: { browsers: "http://b" },
      wiring: {},
    });
    expect(handle.wiring.target_base_url).toBe("https://tenant-42.shop.internal");
  });
});
