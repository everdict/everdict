import {
  BadRequestError,
  InternalError,
  type ServiceHarnessSpec,
  type TargetAcquire,
  type TopologyTarget,
  type TrustZone,
  UpstreamError,
} from "@everdict/contracts";
import type { TargetEnvHandle, TopologyRuntime } from "../deploy/topology-runtime.js";
import { getField, interpolatePath, joinUrl, methodPath } from "./front-door-driver.js";

// Abstraction for target acquisition (WHAT-target) — the fourth sibling of
// TopologyRuntime (WHERE) / FrontDoorDriver (HOW-drive) / ObservationSource (HOW-observe). Separates "how the per-case
// target env is obtained" into a strategy:
//   provision (default) — the runtime brings up a per-case browser container (current provisionBrowserEnv).
//   service             — open the session API of a declared topology service, receive coordinates as wiring, and close on dispose.
// Design: docs/architecture/target-acquisition-generalization.md.

export interface AcquireRequest {
  // The harness topology this acquisition belongs to — read ONLY by the provision lane, which asks the
  // runtime to bring a browser up inside it. The SESSION lane never touches it, and an environment opening
  // its own world through a session API has no topology at all (world-and-engagement-model.md), so it is
  // optional rather than a shape such a caller has to fabricate: a value built to satisfy a parameter that
  // nobody reads is exactly what `pnpm constructed-casts` refuses, and the honest repair is the parameter.
  spec?: ServiceHarnessSpec;
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
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers:
        sendBody !== undefined
          ? { "content-type": "application/json", accept: "application/json" }
          : { accept: "application/json" },
      ...(sendBody !== undefined ? { body: JSON.stringify(sendBody) } : {}),
    });
  } catch (err) {
    // Network failure (connection refused etc.) — remap; a raw fetch error never crosses the boundary.
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { method, url },
      `session request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text().catch(() => "");
  // A failed request must surface the HTTP failure ITSELF. Without this check a 4xx error body flowed into
  // coordinate mapping, which then misreported e.g. a real 422 as "no value at session_ids.0" — the actual
  // cause (status + body) was erased and an entire batch was misdiagnosed as a coordinate-path error.
  if (!res.ok) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { method, url, status: res.status },
      `session request failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`,
    );
  }
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined; // non-JSON 2xx body — a missing coordinate then fails explicitly at the mapping step
  }
};

// provision (default): the runtime brings up a per-case browser — current behavior unchanged (handle wiring = { target_cdp_url }).
export function provisionAcquirer(runtime: TopologyRuntime): TargetAcquirer {
  return {
    async acquire({ spec, runId, zone }) {
      if (spec === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { runId },
          "provisioning a browser needs the harness topology it lives in — this acquisition carried none",
        );
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
      const openUrl = joinUrl(base, interpolatePath(open.path, wiring));
      const res = await openSession(request, open.method, openUrl, acquire.wait, { now, sleep });

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

      // Observation coordinate (optional): the control-plane-reachable CDP base of the browser THIS session opened.
      // Unlike the agent-facing coordinates above it is never required to drive the case, so a missing/malformed value
      // must never fail the eval — the caller records the miss instead (an observability field cannot break an eval).
      const cdpBase = acquire.cdpBase ? reachableString(getField(res, acquire.cdpBase)) : undefined;

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
        ...(cdpBase ? { cdpBase } : {}),
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

// What "the pool is full, come back" looks like on the wire when the harness does not say.
const POOL_FULL_STATUSES = [409, 429];

// The HTTP status behind a refused session open. AppError carries its payload on `extra` (`toEnvelope` is what
// renames it to `data` on the wire) — reading the wire name here is why a full pool went unrecognised.
function refusedStatus(err: unknown): number | undefined {
  const extra = (err as { extra?: { status?: unknown } } | undefined)?.extra;
  return typeof extra?.status === "number" ? extra.status : undefined;
}

// Open a session, waiting out a FULL pool when the harness says how long to wait. Everything else — a bad request,
// an unreachable service, a refusal that is not about capacity — fails immediately: waiting on those would turn a
// clear error into a timeout.
async function openSession(
  request: AcquireRequestFn,
  method: string,
  url: string,
  wait: Extract<TargetAcquire, { mode: "service" }>["wait"],
  io: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<unknown> {
  if (!wait) return await request(method, url);
  const deadline = io.now() + wait.timeoutMs;
  for (;;) {
    try {
      return await request(method, url);
    } catch (err) {
      const status = refusedStatus(err);
      // Not read off `wait.statuses` directly: a spec can reach here without having passed through the schema
      // (an inline spec, an injected registry), and depending on a Zod default to have been applied turns a
      // missing field into a crash inside error handling.
      const full = wait.statuses ?? POOL_FULL_STATUSES;
      // Out of time, or a refusal that means something other than "full" — surface the real error, which still
      // carries the service's own message.
      if (status === undefined || !full.includes(status) || io.now() >= deadline) throw err;
      await io.sleep(wait.intervalMs ?? 1000);
    }
  }
}

// A declared observation coordinate is only usable as a URL base. Anything else (absent, wrong type, empty) reads as
// "this session exposes no reachable CDP" — undefined, never a throw: the eval must not fail over an observability field.
function reachableString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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
// A STATIC api target (harness-definability-spec.md §1): the environment the workspace already runs. Nothing to
// provision, nothing to close; the base URL reaches the agent as the wiring variable `target_base_url`.
export function staticApiAcquirer(baseUrl: string): TargetAcquirer {
  return {
    async acquire() {
      return {
        wiring: { target_base_url: baseUrl },
        async snapshot() {
          return { kind: "prompt", output: "" };
        },
        async dispose() {},
      };
    },
  };
}

export function targetAcquirerFor(
  target: TopologyTarget,
  runtime: TopologyRuntime,
  request: AcquireRequestFn = fetchAcquire,
  io: ServiceAcquirerIo = {},
): TargetAcquirer {
  if (target.acquire?.mode === "service") return serviceAcquirer(target.acquire, request, io);
  switch (target.kind) {
    case "browser":
      return provisionAcquirer(runtime);
    case "api":
      if (target.baseUrl !== undefined) return staticApiAcquirer(target.baseUrl);
      throw new BadRequestError(
        "BAD_REQUEST",
        { target: "api" },
        "an api target without a baseUrl acquires one through a session API (acquire.mode = service) — nothing provisions an API here",
      );
    case "os":
      throw new BadRequestError(
        "BAD_REQUEST",
        { target: "os" },
        "an os target is acquired through a session API (acquire.mode = service) — nothing provisions a desktop here",
      );
    default:
      return assertNeverTarget(target);
  }
}
function assertNeverTarget(value: never): never {
  throw new Error(`unreachable target kind: ${JSON.stringify(value)}`);
}
