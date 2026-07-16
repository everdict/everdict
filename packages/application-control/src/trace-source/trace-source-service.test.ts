import type { BrowsableTraceSource, TraceProbeConfig, TraceProbeResult, WorkspaceSettings } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";
import { TraceSourceService } from "./trace-source-service.js";

// In-memory settings store — shallow partial-merge upsert (mirrors the jsonb-merge contract the service relies on).
function fakeSettings(initial: WorkspaceSettings = {}): WorkspaceSettingsStore {
  let state: WorkspaceSettings = initial;
  return {
    async get() {
      return state;
    },
    async set(_ws, patch) {
      state = { ...state, ...patch };
      return state;
    },
  };
}

describe("TraceSourceService", () => {
  const WS = "acme";

  it("registers a source by name and lists it back without secret values", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await svc.upsert(WS, {
      name: "dev-mlflow",
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev",
      authSecretName: "mlflow-token",
      correlate: "tag",
      project: "12",
      webUrl: "https://mlflow.acme.dev/ui",
    });
    const { sources } = await svc.list(WS);
    expect(sources).toEqual([
      {
        name: "dev-mlflow",
        kind: "mlflow",
        endpoint: "https://mlflow.acme.dev",
        authSecretName: "mlflow-token", // a NAME reference, never the value
        correlate: "tag",
        project: "12",
        webUrl: "https://mlflow.acme.dev/ui", // export deep-link base, round-trips
      },
    ]);
  });

  it("requires a scope for mlflow/phoenix regardless of correlate (traces live inside an experiment/project)", async () => {
    const svc = new TraceSourceService(fakeSettings());
    // mlflow default correlate:'id' still needs the experiment — the meaningful-test fix.
    await expect(svc.upsert(WS, { name: "m", kind: "mlflow", endpoint: "http://mlflow" })).rejects.toThrow(/experiment/);
    await expect(svc.upsert(WS, { name: "p", kind: "phoenix", endpoint: "http://phoenix" })).rejects.toThrow(/project/);
  });

  it("rejects an incoherent otel tag-correlation config (tag without service)", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await expect(
      svc.upsert(WS, { name: "j", kind: "otel", endpoint: "http://jaeger", correlate: "tag" }),
    ).rejects.toThrow(/service/);
  });

  it("selects a PULL source per harness and rejects an unknown source name", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await svc.upsert(WS, { name: "s1", kind: "otel", endpoint: "http://jaeger" });
    await svc.assignSource(WS, "harness-a", "s1");
    expect((await svc.list(WS)).assignments).toEqual({ "harness-a": "s1" });
    await expect(svc.assignSource(WS, "harness-a", "ghost")).rejects.toThrow(/Unregistered source/);
  });

  it("selects an EXPORT target per harness, rejecting an unknown name or an otel source (pull-only)", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await svc.upsert(WS, { name: "lf", kind: "langfuse", endpoint: "http://lf" });
    await svc.upsert(WS, { name: "jg", kind: "otel", endpoint: "http://jaeger" });
    await svc.assignSink(WS, "harness-a", "lf");
    expect((await svc.list(WS)).sinkAssignments).toEqual({ "harness-a": "lf" });
    await expect(svc.assignSink(WS, "harness-a", "ghost")).rejects.toThrow(/Unregistered source/);
    await expect(svc.assignSink(WS, "harness-a", "jg")).rejects.toThrow(/otel/);
  });

  it("removing a source clears BOTH pull and export selections that pointed at it (no dangling reference)", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await svc.upsert(WS, { name: "lf", kind: "langfuse", endpoint: "http://lf" });
    await svc.assignSource(WS, "harness-a", "lf");
    await svc.assignSink(WS, "harness-b", "lf");
    await svc.remove(WS, "lf");
    const { sources, assignments, sinkAssignments } = await svc.list(WS);
    expect(sources).toEqual([]);
    expect(assignments).toEqual({});
    expect(sinkAssignments).toEqual({});
  });

  it("surfaces a legacy trace sink in the unified source pool and migrates it on the next write", async () => {
    const store = fakeSettings({
      traceSinks: [{ name: "legacy-lf", kind: "langfuse", endpoint: "http://lf", project: "p1" }],
      traceSinkByHarness: { "harness-a": "legacy-lf" },
    });
    const svc = new TraceSourceService(store);
    // The legacy sink shows up as a trace source (correlate defaults to "id").
    let roster = await svc.list(WS);
    expect(roster.sources).toEqual([
      { name: "legacy-lf", kind: "langfuse", endpoint: "http://lf", correlate: "id", project: "p1" },
    ]);
    expect(roster.sinkAssignments).toEqual({ "harness-a": "legacy-lf" });
    // A write migrates it into traceSources and clears the legacy field.
    await svc.upsert(WS, { name: "new-src", kind: "otel", endpoint: "http://jaeger" });
    const state = await store.get(WS);
    expect(state?.traceSinks).toEqual([]);
    expect((state?.traceSources ?? []).map((e) => e.name).sort()).toEqual(["legacy-lf", "new-src"]);
    roster = await svc.list(WS);
    expect(roster.sources.map((e) => e.name).sort()).toEqual(["legacy-lf", "new-src"]);
  });

  it("resolve() builds the full TraceSourceConfig for the harness's selection with the auth value from the SecretStore", async () => {
    const svc = new TraceSourceService(fakeSettings(), {
      secretsFor: async () => ({ "mlflow-token": "Basic abc123" }),
    });
    await svc.upsert(WS, {
      name: "dev-mlflow",
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev",
      authSecretName: "mlflow-token",
      correlate: "tag",
      project: "12",
    });
    await svc.assignSource(WS, "harness-a", "dev-mlflow");
    const cfg = await svc.resolve(WS, "harness-a");
    expect(cfg).toEqual({
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev",
      headers: { authorization: "Basic abc123" }, // resolved value, transient — never persisted/returned by list
      correlate: "tag",
      project: "12",
    });
  });

  it("resolve() returns undefined when the harness has no selection (falls back to inline / no pull)", async () => {
    const svc = new TraceSourceService(fakeSettings());
    expect(await svc.resolve(WS, "harness-a")).toBeUndefined();
  });

  it("resolve() merges the per-harness conversion overlay into the dispatch-after-judge config", async () => {
    const svc = new TraceSourceService(
      fakeSettings({ spanAttrMappingByHarness: { "harness-a": { model: ["my.llm.model"] } } }),
    );
    await svc.upsert(WS, { name: "s1", kind: "otel", endpoint: "http://jaeger" });
    await svc.assignSource(WS, "harness-a", "s1");
    const cfg = await svc.resolve(WS, "harness-a");
    expect(cfg?.mapping).toEqual({ model: ["my.llm.model"] });
  });

  it("resolve() fails fast when the referenced auth secret is not in the SecretStore", async () => {
    const svc = new TraceSourceService(fakeSettings(), { secretsFor: async () => ({}) });
    await svc.upsert(WS, { name: "s1", kind: "langfuse", endpoint: "http://lf", authSecretName: "missing" });
    await svc.assignSource(WS, "harness-a", "s1");
    await expect(svc.resolve(WS, "harness-a")).rejects.toThrow(/not registered|No value/);
  });

  it("probe() resolves the auth secret to a value and passes it into the injected probe engine", async () => {
    const ok: TraceProbeResult = { kind: "mlflow", reachable: true, scopeKind: "experiment", scopes: [], detail: "ok" };
    const probeConnection = vi.fn<(cfg: TraceProbeConfig) => Promise<TraceProbeResult>>().mockResolvedValue(ok);
    const svc = new TraceSourceService(fakeSettings(), {
      secretsFor: async () => ({ "mlflow-token": "Basic abc123" }),
      probeConnection,
    });
    const res = await svc.probe(WS, {
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev",
      authSecretName: "mlflow-token",
    });
    expect(res).toBe(ok);
    expect(probeConnection).toHaveBeenCalledWith({
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev",
      auth: "Basic abc123",
    });
  });

  it("probe() returns a friendly reason:'auth' (not a throw) when the referenced secret has no value", async () => {
    const probeConnection = vi.fn<(cfg: TraceProbeConfig) => Promise<TraceProbeResult>>();
    const svc = new TraceSourceService(fakeSettings(), { secretsFor: async () => ({}), probeConnection });
    const res = await svc.probe(WS, { kind: "phoenix", endpoint: "http://phoenix", authSecretName: "missing" });
    expect(res).toMatchObject({ reachable: false, reason: "auth" });
    expect(probeConnection).not.toHaveBeenCalled(); // never reaches the platform without a credential
  });

  it("probe() calls the engine with no auth when there is no authSecretName (unauthenticated dev server)", async () => {
    const probeConnection = vi
      .fn<(cfg: TraceProbeConfig) => Promise<TraceProbeResult>>()
      .mockResolvedValue({ kind: "otel", reachable: true, scopeKind: "service", scopes: [], detail: "ok" });
    const svc = new TraceSourceService(fakeSettings(), { probeConnection });
    await svc.probe(WS, { kind: "otel", endpoint: "http://jaeger:16686" });
    expect(probeConnection).toHaveBeenCalledWith({ kind: "otel", endpoint: "http://jaeger:16686" });
  });

  it("upsert() never invokes the probe engine — registration stays pure (web-only gating)", async () => {
    const probeConnection = vi.fn<(cfg: TraceProbeConfig) => Promise<TraceProbeResult>>();
    const svc = new TraceSourceService(fakeSettings(), { probeConnection });
    await svc.upsert(WS, { name: "s1", kind: "otel", endpoint: "http://jaeger" });
    expect(probeConnection).not.toHaveBeenCalled();
  });

  // The observability browser + judge-wizard sampling — list/inspect over an injected buildSource.
  const fakeBrowsable: BrowsableTraceSource = {
    fetch: async () => [],
    listTraces: async (opts) => [{ id: "t1", ...(opts?.scope ? { scope: opts.scope } : {}) }],
    inspect: async (traceId, mapping) => ({
      events: [],
      rawAttributes: [{ spanName: traceId, attrs: { mappedModel: mapping?.model?.[0] ?? null } }],
    }),
  };

  it("listTraces() builds the source for a registered name and returns its traces", async () => {
    const buildSource = vi.fn(() => fakeBrowsable);
    const svc = new TraceSourceService(fakeSettings(), { buildSource });
    await svc.upsert(WS, { name: "s1", kind: "otel", endpoint: "http://jaeger", service: "svc" });
    const traces = await svc.listTraces(WS, "s1", { scope: "svc" });
    expect(traces).toEqual([{ id: "t1", scope: "svc" }]);
    expect(buildSource).toHaveBeenCalledWith(expect.objectContaining({ kind: "otel", endpoint: "http://jaeger" }));
  });

  it("inspect() passes the supplied mapping through to the source (wizard live-authoring loop)", async () => {
    const svc = new TraceSourceService(fakeSettings(), { buildSource: () => fakeBrowsable });
    await svc.upsert(WS, { name: "s1", kind: "mlflow", endpoint: "http://mlflow", project: "0" });
    const r = await svc.inspect(WS, "s1", "tid", { model: ["custom.model"] });
    expect(r.rawAttributes?.[0]).toEqual({ spanName: "tid", attrs: { mappedModel: "custom.model" } });
  });

  it("listTraces() 404s an unregistered source name", async () => {
    const svc = new TraceSourceService(fakeSettings(), { buildSource: () => fakeBrowsable });
    await expect(svc.listTraces(WS, "ghost")).rejects.toThrow(/Unregistered trace source/);
  });

  it("listTraces() 400s when the browse engine (buildSource) is not configured", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await svc.upsert(WS, { name: "s1", kind: "otel", endpoint: "http://jaeger" });
    await expect(svc.listTraces(WS, "s1")).rejects.toThrow(/not configured/);
  });
});
