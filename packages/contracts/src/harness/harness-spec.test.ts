import { describe, expect, it } from "vitest";
import {
  FrontDoorSpecSchema,
  ServiceHarnessSpecSchema,
  TopologyDependencySchema,
  injectTemplateFields,
} from "./harness-spec.js";

const base = { store: "redis", role: "queue", purpose: "plumbing", isolateBy: "key-prefix" };

describe("TopologyDependencySchema.inject — BYO store env names validated at the boundary", () => {
  it("accepts a dependency without inject (back-compat)", () => {
    expect(TopologyDependencySchema.safeParse(base).success).toBe(true);
  });

  it("accepts an inject entry with no template (defaults to the canonical {url})", () => {
    const parsed = TopologyDependencySchema.safeParse({ ...base, inject: [{ env: "VALKEY_URL" }] });
    expect(parsed.success).toBe(true);
  });

  it("accepts a template over the store's field vocabulary", () => {
    const parsed = TopologyDependencySchema.safeParse({
      ...base,
      inject: [{ env: "VALKEY_URL", template: "valkey://{userinfo}{host}:{port}" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a template field outside the store's vocabulary — an authoring bug, not a verbatim passthrough", () => {
    const parsed = TopologyDependencySchema.safeParse({
      ...base,
      inject: [{ env: "VALKEY_URL", template: "redis://{host}:{port}/{database}" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("{database}");
  });

  it("rejects inject on an external dependency — Everdict deploys nothing, so there are no coordinates to render", () => {
    const parsed = TopologyDependencySchema.safeParse({
      ...base,
      isolateBy: "external",
      inject: [{ env: "VALKEY_URL" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("external");
  });

  it("rejects an empty env key", () => {
    const parsed = TopologyDependencySchema.safeParse({ ...base, inject: [{ env: "" }] });
    expect(parsed.success).toBe(false);
  });
});

describe("injectTemplateFields", () => {
  it("extracts every {field} token", () => {
    expect(injectTemplateFields("valkey://{userinfo}{host}:{port}")).toEqual(["userinfo", "host", "port"]);
  });

  it("returns nothing for a literal template", () => {
    expect(injectTemplateFields("redis://fixed:6379")).toEqual([]);
  });
});

describe('FrontDoorSpecSchema — the "trace" completion model', () => {
  const fd = { service: "agent-server", submit: "POST /runs" };

  it("accepts trace completion and applies the probe defaults (2s interval / 120s timeout)", () => {
    const parsed = FrontDoorSpecSchema.parse({ ...fd, completion: { mode: "trace" } });
    expect(parsed.completion).toEqual({ mode: "trace", intervalMs: 2000, timeoutMs: 120000 });
  });

  it('rejects correlate "returned" with trace completion — the submit response is never awaited', () => {
    const res = FrontDoorSpecSchema.safeParse({
      ...fd,
      completion: { mode: "trace" },
      correlate: { mode: "returned", path: "run_id" },
    });
    expect(res.success).toBe(false);
  });

  it("rejects traceInline with trace completion — the trace is pulled from the traceSource, not the response", () => {
    const res = FrontDoorSpecSchema.safeParse({ ...fd, completion: { mode: "trace" }, traceInline: {} });
    expect(res.success).toBe(false);
  });

  it("keeps allowing returned correlation for the response-bearing models (no regression)", () => {
    const res = FrontDoorSpecSchema.safeParse({ ...fd, correlate: { mode: "returned", path: "run_id" } });
    expect(res.success).toBe(true);
  });
});

describe("TopologyService exec — the host-exec pairing rules (validateServiceExec)", () => {
  const spec = (svc: Record<string, unknown>) => ({
    kind: "service",
    id: "t",
    version: "1.0.0",
    services: [svc],
    dependencies: [],
    frontDoor: { service: "s", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://x" },
  });
  const hostSvc = {
    name: "win-ui",
    needs: [],
    perRun: [],
    replicas: 1,
    env: {},
    requires: { os: "windows" },
    exec: { kind: "host", command: ["C:/drivers/ui-driver.exe", "--serve"] },
  };

  it("accepts a host-exec service with a command and no image (the Windows-without-Docker contract)", () => {
    expect(ServiceHarnessSpecSchema.safeParse(spec(hostSvc)).success).toBe(true);
  });

  it("rejects a host-exec service without exec.command", () => {
    expect(ServiceHarnessSpecSchema.safeParse(spec({ ...hostSvc, exec: { kind: "host" } })).success).toBe(false);
  });

  it("rejects a host-exec service that also sets an image (nothing would run it)", () => {
    expect(ServiceHarnessSpecSchema.safeParse(spec({ ...hostSvc, image: "reg/x:1" })).success).toBe(false);
  });

  it("rejects a containerized service without an image (pre-existing invariant, now explicit)", () => {
    expect(
      ServiceHarnessSpecSchema.safeParse(spec({ name: "s", needs: [], perRun: [], replicas: 1, env: {} })).success,
    ).toBe(false);
  });
});
