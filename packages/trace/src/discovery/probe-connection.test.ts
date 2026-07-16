import { describe, expect, it, vi } from "vitest";
import {
  parseJaegerServices,
  parseLangfuseProjects,
  parseLangsmithSessions,
  parseMlflowExperiments,
  parsePhoenixProjects,
  probeTraceConnection,
} from "./probe-connection.js";

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const status = (code: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: code }));

describe("trace probe — pure scope parsers", () => {
  it("maps MLflow experiments/search to {id:experiment_id, name}", () => {
    expect(
      parseMlflowExperiments({ experiments: [{ experiment_id: "42", name: "acme-eval" }, { experiment_id: "7" }] }),
    ).toEqual([
      { id: "42", name: "acme-eval" },
      { id: "7", name: "7" }, // name falls back to the id when absent
    ]);
  });

  it("maps Phoenix/Langfuse {data:[{id,name}]} to scopes (id coerced to string)", () => {
    const scopes = parsePhoenixProjects({
      data: [
        { id: "p1", name: "default" },
        { id: 2, name: "other" },
      ],
    });
    expect(scopes).toEqual([
      { id: "p1", name: "default" },
      { id: "2", name: "other" },
    ]);
    expect(parseLangfuseProjects).toBe(parsePhoenixProjects); // same shape, shared parser
  });

  it("maps a LangSmith bare sessions array to scopes", () => {
    expect(parseLangsmithSessions([{ id: "s1", name: "prod" }])).toEqual([{ id: "s1", name: "prod" }]);
  });

  it("maps Jaeger {data:[service...]} to scopes with service as id+name", () => {
    expect(parseJaegerServices({ data: ["agent-a", "agent-b"] })).toEqual([
      { id: "agent-a", name: "agent-a" },
      { id: "agent-b", name: "agent-b" },
    ]);
  });

  it("returns [] for malformed bodies (never throws)", () => {
    expect(parseMlflowExperiments({})).toEqual([]);
    expect(parsePhoenixProjects(null)).toEqual([]);
    expect(parseLangsmithSessions({ nope: true })).toEqual([]);
  });
});

describe("probeTraceConnection — validation + discovery", () => {
  it("MLflow: POSTs experiments/search with max_results + Authorization, returns the experiments as scopes", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      ok({ experiments: [{ experiment_id: "42", name: "acme-eval" }] }),
    );
    const res = await probeTraceConnection({
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev/",
      auth: "Basic dXNlcjpwYXNz",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(res).toMatchObject({ kind: "mlflow", reachable: true, scopeKind: "experiment" });
    expect(res.scopes).toEqual([{ id: "42", name: "acme-eval" }]);
    const [firstCall] = fetchImpl.mock.calls;
    if (!firstCall) throw new Error("fetch was not called");
    const [url, init] = firstCall;
    expect(url).toBe("https://mlflow.acme.dev/api/2.0/mlflow/experiments/search"); // trailing slash trimmed
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ max_results: 1000 });
    expect((init?.headers as Record<string, string>).authorization).toBe("Basic dXNlcjpwYXNz");
  });

  it("LangSmith: sends the credential as x-api-key (not Authorization) against the bare /sessions path", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => ok([{ id: "s1", name: "prod" }]));
    const res = await probeTraceConnection({
      kind: "langsmith",
      endpoint: "https://api.smith.langchain.com",
      auth: "lsv2_key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(res).toMatchObject({ reachable: true, scopeKind: "project" });
    const [firstCall] = fetchImpl.mock.calls;
    if (!firstCall) throw new Error("fetch was not called");
    const [url, init] = firstCall;
    expect(url).toBe("https://api.smith.langchain.com/sessions?limit=100");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("lsv2_key");
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("Phoenix: lists projects via GET /v1/projects", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => ok({ data: [{ id: "p1", name: "default" }] }));
    const res = await probeTraceConnection({
      kind: "phoenix",
      endpoint: "http://phoenix:6006",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(res.scopes).toEqual([{ id: "p1", name: "default" }]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://phoenix:6006/v1/projects");
  });

  it("401/403 → reason:'auth' (not reachable)", async () => {
    const res = await probeTraceConnection({
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev",
      fetchImpl: (() => status(401, {})) as typeof fetch,
    });
    expect(res).toMatchObject({ reachable: false, reason: "auth" });
    expect(res.scopes).toBeUndefined();
  });

  it("other non-2xx → reason:'error'", async () => {
    const res = await probeTraceConnection({
      kind: "mlflow",
      endpoint: "https://mlflow.acme.dev",
      fetchImpl: (() => status(500, { message: "boom" })) as typeof fetch,
    });
    expect(res).toMatchObject({ reachable: false, reason: "error" });
  });

  it("a network throw → reason:'unreachable'", async () => {
    const res = await probeTraceConnection({
      kind: "phoenix",
      endpoint: "http://dead:6006",
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    });
    expect(res).toMatchObject({ reachable: false, reason: "unreachable", detail: "ECONNREFUSED" });
  });

  it("OTel non-Jaeger (no /api/services) → reachable with an empty service list (still registerable for correlate:id)", async () => {
    const res = await probeTraceConnection({
      kind: "otel",
      endpoint: "http://otel-collector:4318",
      fetchImpl: (() => status(404, {})) as typeof fetch,
    });
    expect(res).toMatchObject({ reachable: true, scopeKind: "service" });
    expect(res.scopes).toEqual([]);
  });

  it("caps a hung endpoint with the timeout → reason:'unreachable'", async () => {
    const res = await probeTraceConnection({
      kind: "mlflow",
      endpoint: "https://slow.acme.dev",
      timeoutMs: 20,
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch, // never resolves
    });
    expect(res).toMatchObject({ reachable: false, reason: "unreachable" });
  });
});
