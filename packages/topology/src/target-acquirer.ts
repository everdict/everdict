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

// Abstraction for target acquisition (WHAT-target) — the fourth sibling of
// TopologyRuntime (WHERE) / FrontDoorDriver (HOW-drive) / ObservationSource (HOW-observe). Separates "how the per-case
// target env is obtained" into a strategy:
//   provision (default) — the runtime brings up a per-case browser container (current provisionBrowserEnv).
//   service             — open the session API of a declared topology service, receive coordinates as wiring, and close on dispose.
// Design: docs/architecture/target-acquisition-generalization.md.

export interface AcquireRequest {
  spec: ServiceHarnessSpec;
  runId: string;
  endpoints: Record<string, string>; // warm topology service → base URL (reach the session service)
  wiring: Record<string, string>; // open/close path interpolation (run_id + isolateBy-derived + task). Coordinates are merged in at close.
  zone?: TrustZone;
}

export interface TargetAcquirer {
  acquire(req: AcquireRequest): Promise<TargetEnvHandle>;
}

// Method-aware HTTP primitive — handles open (POST/GET) / close (DELETE) generically (submit/getJson are POST/GET only).
// Injected in tests. Parses leniently even if the response isn't JSON or is empty (a missing coordinate fails explicitly at the mapping step).
export type AcquireRequestFn = (method: string, url: string, body?: unknown) => Promise<unknown>;

// Readiness probe — ready when the status URL returns 200 (2xx). 404 etc. if the session client hasn't back-connected yet.
export type ProbeFn = (method: string, url: string) => Promise<boolean>;

export const fetchProbe: ProbeFn = async (method, url) => {
  try {
    const res = await fetch(url, { method, headers: { accept: "application/json" } });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false; // connection refused / network error = not ready yet
  }
};

// Injectable IO for serviceAcquirer — defaults to a real fetch probe + real clock (tests inject fakes for deterministic polling).
export interface ServiceAcquirerIo {
  probe?: ProbeFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const fetchAcquire: AcquireRequestFn = async (method, url, body) => {
  // A bodyless POST (e.g. a parameterless session open) sends an empty {} — prevents a server that requires a JSON body
  // from rejecting a bodyless POST with 422. GET/DELETE stay bodyless (if someone passes an explicit body, honor it).
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

// provision (default): the runtime brings up a per-case browser — current behavior unchanged (handle wiring = { target_cdp_url }).
export function provisionAcquirer(runtime: TopologyRuntime): TargetAcquirer {
  return {
    async acquire({ spec, runId, zone }) {
      return runtime.provisionBrowserEnv(spec, runId, zone);
    },
  };
}

// service: open a declared service's session API and receive a coordinate bag. Everdict owns no stage (no container),
// so observation goes via delivery (sentinel/egress) — the built-in snapshot falls back to prompt (no stage). Mirror of the
// front-door driver (target edition): open=submit, coordinates=correlate (a coordinate bag, not a single id), close=lifecycle teardown.
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
          "No endpoint for the target session service.",
        );
      }
      const open = methodPath(acquire.open);
      const res = await request(open.method, joinUrl(base, interpolatePath(open.path, wiring)));

      // Coordinate mapping: dot-path in the open response → wiring variables. Missing/format-mismatch fails explicitly rather than silently (external-contract error).
      const coords: Record<string, string> = {};
      try {
        for (const [name, path] of Object.entries(acquire.coordinates)) {
          const value = getField(res, path);
          if (typeof value !== "string" || value === "") {
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { name, path, got: value },
              `Could not find coordinate (${name} ← ${path}) in the session-open response.`,
            );
          }
          coords[name] = value;
        }
      } catch (err) {
        // Session opened but coordinate mapping failed — best-effort close with the coordinates gathered so far, then rethrow (same discipline as #6), to avoid a leak.
        await closeSession(request, base, acquire.close, { ...wiring, ...coords }).catch(() => {});
        throw err;
      }

      const closeWiring = { ...wiring, ...coords };

      // Readiness gate: the session is open, but until its client (browser etc.) self-registers via back-connect, front-door
      // commands bounce with 404. If ready is set, poll the status URL until 200 — on timeout, close (don't leak the open session) then fail.
      if (acquire.ready) {
        const ready = acquire.ready;
        const readyBase = endpoints[ready.service ?? acquire.service];
        if (!readyBase) {
          await closeSession(request, base, acquire.close, closeWiring).catch(() => {});
          throw new InternalError(
            "HARNESS_RUN_FAILED",
            { service: ready.service ?? acquire.service },
            "No endpoint for the readiness-check service.",
          );
        }
        const rp = methodPath(ready.poll);
        const readyUrl = joinUrl(readyBase, interpolatePath(rp.path, closeWiring)); // interpolate coordinates like {session_id}
        const start = now();
        let isReady = false;
        while (now() - start < ready.timeoutMs) {
          let ok = false;
          try {
            ok = await probe(rp.method, readyUrl);
          } catch {
            ok = false; // probe throw = not ready yet → retry
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
            "Timed out waiting for the target session to become ready",
          );
        }
      }

      return {
        wiring: coords,
        async snapshot() {
          return { kind: "prompt", output: "" }; // No Everdict-owned stage — the real observation is delivered via delivery (sentinel/egress).
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

// target.acquire → acquisition strategy. unset/provision = runtime provision (current), service = session-API acquisition.
// An unknown mode is filtered at the boundary by the schema (discriminatedUnion).
export function targetAcquirerFor(
  target: TopologyTarget,
  runtime: TopologyRuntime,
  request: AcquireRequestFn = fetchAcquire,
  io: ServiceAcquirerIo = {},
): TargetAcquirer {
  if (target.acquire?.mode === "service") return serviceAcquirer(target.acquire, request, io);
  return provisionAcquirer(runtime);
}
