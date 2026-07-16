import type { TraceProbeConfig, TraceProbeResult, TraceScopeKind, TraceScopeOption } from "@everdict/contracts";

// Connection test + scope discovery for a trace source/sink, run BEFORE registration. One lightweight authed
// call per platform: it both proves the base URL + credential connect AND lists the platform's selectable
// scopes (mlflow experiments · phoenix/langfuse/langsmith projects · otel[jaeger] services). Reused by both
// the TraceSourceService and TraceSinkService (injected — application-control never imports @everdict/trace).
//
// Auth discipline mirrors the source/sink adapters: the credential VALUE is passed in and the adapter owns the
// header name (langsmith → x-api-key, the others → verbatim Authorization). The response parsers are pure
// (unit-testable with sample JSON); only the fetch does I/O. A reachability failure is a classified RESULT,
// never a thrown error (the caller renders reason). A 10s Promise.race caps an unreachable endpoint.

const DEFAULT_TIMEOUT_MS = 10_000;
const trimSlash = (endpoint: string): string => endpoint.replace(/\/$/, "");

// --- Pure response parsers (raw platform JSON → selectable scopes) -------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

// MLflow 2.0 experiments/search → { experiments: [{ experiment_id, name }] }. Store experiment_id, show name.
export function parseMlflowExperiments(body: unknown): TraceScopeOption[] {
  const experiments = asRecord(body).experiments;
  if (!Array.isArray(experiments)) return [];
  const out: TraceScopeOption[] = [];
  for (const e of experiments) {
    if (typeof e !== "object" || e === null) continue;
    const rec = e as Record<string, unknown>;
    const id = rec.experiment_id;
    if (typeof id === "string") out.push({ id, name: typeof rec.name === "string" ? rec.name : id });
  }
  return out;
}

// Phoenix /v1/projects and Langfuse /api/public/projects both return { data: [{ id, name }] }.
function parseDataProjects(body: unknown): TraceScopeOption[] {
  const data = asRecord(body).data;
  if (!Array.isArray(data)) return [];
  const out: TraceScopeOption[] = [];
  for (const p of data) {
    if (typeof p !== "object" || p === null) continue;
    const rec = p as Record<string, unknown>;
    const id = rec.id;
    if (id === undefined || id === null) continue;
    const idStr = String(id);
    out.push({ id: idStr, name: typeof rec.name === "string" ? rec.name : idStr });
  }
  return out;
}
export const parsePhoenixProjects = parseDataProjects;
export const parseLangfuseProjects = parseDataProjects;

// LangSmith /sessions → a bare array [{ id, name }] (sessions == projects).
export function parseLangsmithSessions(body: unknown): TraceScopeOption[] {
  if (!Array.isArray(body)) return [];
  const out: TraceScopeOption[] = [];
  for (const s of body) {
    if (typeof s !== "object" || s === null) continue;
    const rec = s as Record<string, unknown>;
    const id = rec.id;
    if (id === undefined || id === null) continue;
    const idStr = String(id);
    out.push({ id: idStr, name: typeof rec.name === "string" ? rec.name : idStr });
  }
  return out;
}

// Jaeger /api/services → { data: ["svc-a", "svc-b"] }. Service name is both the id and the label.
export function parseJaegerServices(body: unknown): TraceScopeOption[] {
  const data = asRecord(body).data;
  if (!Array.isArray(data)) return [];
  const out: TraceScopeOption[] = [];
  for (const s of data) if (typeof s === "string") out.push({ id: s, name: s });
  return out;
}

// --- Per-kind request + parse descriptors -------------------------------------------------------------------

interface KindSpec {
  scopeKind: TraceScopeKind;
  request(base: string, auth?: string): { url: string; init: RequestInit };
  parse(json: unknown): TraceScopeOption[];
  // otel: an OTLP-native collector legitimately has no service-list API — a non-2xx there is "reachable but
  // can't list", not an error (so a valid OTLP endpoint stays registerable for correlate:"id").
  tolerateNon2xx?: boolean;
}

const authHeader = (auth?: string): Record<string, string> => (auth ? { authorization: auth } : {});

const SPECS: Record<TraceProbeConfig["kind"], KindSpec> = {
  mlflow: {
    scopeKind: "experiment",
    request: (base, auth) => ({
      url: `${base}/api/2.0/mlflow/experiments/search`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader(auth) },
        body: JSON.stringify({ max_results: 1000 }),
      },
    }),
    parse: parseMlflowExperiments,
  },
  phoenix: {
    scopeKind: "project",
    request: (base, auth) => ({ url: `${base}/v1/projects`, init: { headers: { ...authHeader(auth) } } }),
    parse: parsePhoenixProjects,
  },
  langfuse: {
    scopeKind: "project",
    request: (base, auth) => ({ url: `${base}/api/public/projects`, init: { headers: { ...authHeader(auth) } } }),
    parse: parseLangfuseProjects,
  },
  langsmith: {
    scopeKind: "project",
    // The credential is the x-api-key header (not Authorization). Base path is verbatim (no /api/v1) — matching LangsmithTraceSource's bare `${base}/runs/query`.
    request: (base, auth) => ({
      url: `${base}/sessions?limit=100`,
      init: { headers: { ...(auth ? { "x-api-key": auth } : {}) } },
    }),
    parse: parseLangsmithSessions,
  },
  otel: {
    scopeKind: "service",
    request: (base, auth) => ({ url: `${base}/api/services`, init: { headers: { ...authHeader(auth) } } }),
    parse: parseJaegerServices,
    tolerateNon2xx: true,
  },
};

// --- Engine -------------------------------------------------------------------------------------------------

// Probe a trace source/sink connection and discover its selectable scopes. Never throws for reachability — the
// outcome (reachable/reason/scopes) is the return value. Injected fetchImpl for tests; 10s Promise.race timeout.
export async function probeTraceConnection(cfg: TraceProbeConfig): Promise<TraceProbeResult> {
  const f = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spec = SPECS[cfg.kind];
  const { url, init } = spec.request(trimSlash(cfg.endpoint), cfg.auth);

  const timeout = new Promise<TraceProbeResult>((resolve) =>
    setTimeout(
      () =>
        resolve({
          kind: cfg.kind,
          reachable: false,
          reason: "unreachable",
          detail: `Connection test timed out (${timeoutMs / 1000}s)`,
        }),
      timeoutMs,
    ),
  );

  const attempt = (async (): Promise<TraceProbeResult> => {
    let res: Response;
    try {
      res = await f(url, init);
    } catch (e) {
      // Network-level failure (DNS/refused/TLS) — the endpoint is unreachable.
      return {
        kind: cfg.kind,
        reachable: false,
        reason: "unreachable",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    if (res.status === 401 || res.status === 403)
      return {
        kind: cfg.kind,
        reachable: false,
        reason: "auth",
        detail: `${cfg.kind} probe ${res.status}: authentication failed`,
      };
    if (!res.ok) {
      if (spec.tolerateNon2xx)
        return {
          kind: cfg.kind,
          reachable: true,
          scopeKind: spec.scopeKind,
          scopes: [],
          detail: `Connected — this endpoint exposes no ${spec.scopeKind} list API (HTTP ${res.status}).`,
        };
      const text = await res.text().catch(() => "");
      return {
        kind: cfg.kind,
        reachable: false,
        reason: "error",
        detail: `${cfg.kind} probe ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    const scopes = spec.parse(json);
    return {
      kind: cfg.kind,
      reachable: true,
      scopeKind: spec.scopeKind,
      scopes,
      detail: `Connected (${scopes.length} ${spec.scopeKind}${scopes.length === 1 ? "" : "s"}).`,
    };
  })();

  return Promise.race([attempt, timeout]);
}
