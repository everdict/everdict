import type { TraceProbeConfig, TraceProbeResult, WorkspaceSettings } from "@everdict/contracts";
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
      },
    ]);
  });

  it("rejects an incoherent tag-correlation config (otel tag without service, mlflow tag without project)", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await expect(
      svc.upsert(WS, { name: "j", kind: "otel", endpoint: "http://jaeger", correlate: "tag" }),
    ).rejects.toThrow(/service/);
    await expect(
      svc.upsert(WS, { name: "m", kind: "mlflow", endpoint: "http://mlflow", correlate: "tag" }),
    ).rejects.toThrow(/project/);
  });

  it("selects a source per harness and rejects an unknown source name", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await svc.upsert(WS, { name: "s1", kind: "otel", endpoint: "http://jaeger" });
    await svc.assign(WS, "harness-a", "s1");
    expect((await svc.list(WS)).assignments).toEqual({ "harness-a": "s1" });
    await expect(svc.assign(WS, "harness-a", "ghost")).rejects.toThrow(/Unregistered source/);
  });

  it("removing a source also clears harness selections that pointed at it (no dangling reference)", async () => {
    const svc = new TraceSourceService(fakeSettings());
    await svc.upsert(WS, { name: "s1", kind: "otel", endpoint: "http://jaeger" });
    await svc.assign(WS, "harness-a", "s1");
    await svc.remove(WS, "s1");
    const { sources, assignments } = await svc.list(WS);
    expect(sources).toEqual([]);
    expect(assignments).toEqual({});
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
    await svc.assign(WS, "harness-a", "dev-mlflow");
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

  it("resolve() fails fast when the referenced auth secret is not in the SecretStore", async () => {
    const svc = new TraceSourceService(fakeSettings(), { secretsFor: async () => ({}) });
    await svc.upsert(WS, { name: "s1", kind: "langfuse", endpoint: "http://lf", authSecretName: "missing" });
    await svc.assign(WS, "harness-a", "s1");
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
});
