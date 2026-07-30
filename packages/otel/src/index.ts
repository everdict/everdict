// @everdict/otel — the user-facing convenience layer for sending traces to everdict's OTLP door
// (native-observability N2, "libraries for users, not adapters for us"). DELIBERATELY dependency-free:
// no OTel SDK, no zod, no internal packages — everything here is strings, because pointing an existing
// OTLP-speaking stack at everdict is configuration, not code. The Python story needs no package at all
// (the same env vars — see docs/everdict-otel.md); this module exists so TS users don't hand-assemble them.

// The everdict semantic conventions — the resource/span attributes the door groups and correlates by.
// MUST stay in lockstep with @everdict/trace's EVERDICT_SEMCONV (drift-guarded by test): this copy exists
// so the user-facing package carries zero internal dependencies.
export const EVERDICT_SEMCONV = {
  runId: "everdict.run_id",
  kind: "everdict.kind",
  caseId: "everdict.case_id",
  groupId: "everdict.group_id",
} as const;

export interface EverdictCorrelation {
  runId: string; // the everdict run this trace belongs to — the door REFUSES spans without one (visibly)
  kind?: string; // executable family (eval | agent | command | sandbox | analysis) when known
  caseId?: string;
  groupId?: string;
}

// The correlation as resource attributes — hand to your SDK's Resource (TS: resourceFromAttributes(...),
// Py: Resource.create(...)). Resource-level is the right layer: one process, one run.
export function everdictResourceAttributes(correlation: EverdictCorrelation): Record<string, string> {
  return {
    [EVERDICT_SEMCONV.runId]: correlation.runId,
    ...(correlation.kind !== undefined ? { [EVERDICT_SEMCONV.kind]: correlation.kind } : {}),
    ...(correlation.caseId !== undefined ? { [EVERDICT_SEMCONV.caseId]: correlation.caseId } : {}),
    ...(correlation.groupId !== undefined ? { [EVERDICT_SEMCONV.groupId]: correlation.groupId } : {}),
  };
}

// The same correlation as the OTEL_RESOURCE_ATTRIBUTES env value ("k=v,k=v") — the zero-code path: any
// OTel-instrumented process picks it up without touching its source.
export function everdictResourceAttributesEnv(correlation: EverdictCorrelation): string {
  return Object.entries(everdictResourceAttributes(correlation))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

export interface EverdictExporterConfig {
  endpoint: string; // the everdict control plane base URL (the door is POST {endpoint}/v1/traces)
  apiKey: string; // a tenant API key (ak_…) — the v0 ingest credential
}

// The exporter env pair every OTLP/HTTP SDK understands. Set these (plus OTEL_RESOURCE_ATTRIBUTES above)
// and an existing OTel/Langfuse/LangSmith-SDK app exports to everdict with NO code change.
export function everdictExporterEnv(config: EverdictExporterConfig): {
  OTEL_EXPORTER_OTLP_ENDPOINT: string;
  OTEL_EXPORTER_OTLP_HEADERS: string;
  OTEL_EXPORTER_OTLP_PROTOCOL: string;
} {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: config.endpoint.replace(/\/$/, ""),
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${config.apiKey}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", // the door speaks OTLP/HTTP JSON (N0)
  };
}

// The exporter settings as plain values — for SDKs configured in code rather than env (TS
// OTLPTraceExporter({url, headers}), Py OTLPSpanExporter(endpoint=…, headers=…)).
export function everdictExporterOptions(config: EverdictExporterConfig): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url: `${config.endpoint.replace(/\/$/, "")}/v1/traces`,
    headers: { Authorization: `Bearer ${config.apiKey}` },
  };
}
