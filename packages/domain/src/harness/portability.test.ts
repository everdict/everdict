import { BadRequestError, type ServiceHarnessSpec, type TopologyService } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type PortabilityRule, assertPortable, checkPortability } from "./portability.js";

const svc = (over: Partial<TopologyService> & { name: string }): TopologyService => ({
  image: "img:1",
  needs: [],
  perRun: [],
  replicas: 1,
  env: {},
  ...over,
});

const spec = (services: TopologyService[], over: Partial<ServiceHarnessSpec> = {}): ServiceHarnessSpec => ({
  kind: "service",
  id: "h",
  version: "1",
  services,
  dependencies: [],
  frontDoor: { service: services[0]?.name ?? "web", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel.example.com" },
  ...over,
});

const rules = (spc: ServiceHarnessSpec): PortabilityRule[] => checkPortability(spc).map((i) => i.rule);

describe("checkPortability", () => {
  it("a spec that addresses peers only via {{peer}} with matching needs+port is portable (no issues)", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://{{api}}/v1" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(checkPortability(s)).toEqual([]);
  });

  it("flags a literal localhost host in a service env value", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]);
    expect(rules(s)).toContain("no-literal-host");
  });

  it("flags a hardcoded private IP host", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://10.0.0.5:4000" } })]);
    expect(rules(s)).toContain("no-literal-host");
  });

  it("flags a peer addressed by its literal service name (should be {{peer}})", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://api:4000" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(rules(s)).toContain("peer-by-literal");
  });

  it("flags a {{peer}} reference not declared in needs (works on Docker, fails on per-service Nomad)", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: [], env: { API_URL: "http://{{api}}" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(rules(s)).toContain("needs-complete");
  });

  it("flags a referenced peer that exposes no port", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://{{api}}" } }),
      svc({ name: "api" }), // no port
    ]);
    expect(rules(s)).toContain("addressed-has-port");
  });

  it("flags a front door that references an undeclared service", () => {
    const s = spec([svc({ name: "web", port: 3000 })], { frontDoor: { service: "gateway", submit: "POST /runs" } });
    expect(rules(s)).toContain("reference-not-address");
  });

  it("flags two services sharing a port (co-located netns forbids it)", () => {
    const s = spec([svc({ name: "web", port: 3000 }), svc({ name: "api", port: 3000 })]);
    expect(rules(s)).toContain("unique-ports");
  });

  it("warns (not errors) that an INTERNAL object store's artifacts won't reach the judge — so it never blocks registration", () => {
    const s = spec([svc({ name: "web", port: 3000 })], {
      dependencies: [{ store: "minio", role: "artifacts", purpose: "plumbing", isolateBy: "object-prefix" }],
    });
    const issues = checkPortability(s);
    const art = issues.find((i) => i.rule === "artifact-store-internal");
    expect(art?.severity).toBe("warning"); // surfaced, never blocks
    expect(art?.field).toBe("dependencies[artifacts]");
    expect(art?.message).toMatch(/won't reach the judge|inline|external/i);
    // it is a warning only — a topology with an internal store still registers (assertPortable throws on errors only).
    expect(() => assertPortable(s)).not.toThrow();
  });

  it("warns (not errors) when a service.env literal shares a key with a dependency inject mapping — the inject always wins, the literal is dead", () => {
    const s = spec([svc({ name: "app", port: 3000, env: { VALKEY_URL: "redis://stale:6379" } })], {
      dependencies: [
        {
          store: "redis",
          role: "queue",
          purpose: "plumbing",
          isolateBy: "key-prefix",
          inject: [{ env: "VALKEY_URL" }],
        },
      ],
    });
    const issue = checkPortability(s).find((i) => i.rule === "inject-shadowed-literal");
    expect(issue?.severity).toBe("warning");
    expect(issue?.field).toBe("services[app].env.VALKEY_URL");
    expect(() => assertPortable(s)).not.toThrow(); // warning only — never blocks registration
  });

  it("scopes the inject-shadow warning by dep.service and skips non-colliding keys", () => {
    const s = spec(
      [
        svc({ name: "app", port: 3000, env: { VALKEY_URL: "redis://stale:6379" } }),
        svc({ name: "worker", env: { VALKEY_URL: "redis://stale:6379" } }),
      ],
      {
        dependencies: [
          {
            store: "redis",
            role: "queue",
            purpose: "plumbing",
            isolateBy: "key-prefix",
            service: "worker",
            inject: [{ env: "VALKEY_URL" }],
          },
        ],
      },
    );
    const shadowed = checkPortability(s).filter((i) => i.rule === "inject-shadowed-literal");
    expect(shadowed.map((i) => i.service)).toEqual(["worker"]); // app's literal is untouched — the mapping targets worker only
  });

  it("does NOT warn when the object store is external (BYO, control-plane-reachable) or is a non-object store (pg/redis)", () => {
    const external = spec([svc({ name: "web", port: 3000 })], {
      dependencies: [{ store: "minio", role: "artifacts", purpose: "plumbing", isolateBy: "external" }],
    });
    expect(rules(external)).not.toContain("artifact-store-internal");
    const kv = spec([svc({ name: "web", port: 3000 })], {
      dependencies: [{ store: "redis", role: "bus", purpose: "plumbing", isolateBy: "key-prefix" }],
    });
    expect(rules(kv)).not.toContain("artifact-store-internal");
  });

  it("scans the front-door bodyTemplate for a literal host", () => {
    const s = spec([svc({ name: "web", port: 3000 })], {
      frontDoor: { service: "web", submit: "POST /runs", request: { bodyTemplate: { base: "http://127.0.0.1:8000" } } },
    });
    expect(rules(s)).toContain("no-literal-host");
  });

  it("does not scan a { secretRef } env value (no authored address there)", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { TOKEN: { secretRef: "api-key" } } })]);
    expect(checkPortability(s)).toEqual([]);
  });

  it("flags a peer addressed by literal name via the wiring[] BYO env injection without a needs edge", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: [], wiring: [{ service: "bus", hostEnv: "SE_EVENT_BUS_HOST" }] }),
      svc({ name: "bus", port: 5557 }),
    ]);
    expect(rules(s)).toContain("needs-complete");
  });

  it("lints a template-shaped (image-less) service spec identically — so authoring-time validation catches it", () => {
    // A ServiceTemplateSpec's services omit `image`; portability is purely structural over addressing, so the same
    // function accepts it. This is what /harness-templates/validate calls to surface issues before the template lands.
    const templateSpec: import("./portability.js").PortabilityServiceSpec = {
      kind: "service",
      id: "h",
      version: "1",
      services: [
        { name: "web", port: 3000, needs: ["api"], perRun: [], replicas: 1, env: { API_URL: "http://api:4000" } },
        { name: "api", port: 4000, needs: [], perRun: [], replicas: 1, env: {} },
      ],
      dependencies: [],
      frontDoor: { service: "web", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://otel.example.com" },
    };
    expect(checkPortability(templateSpec).map((i) => i.rule)).toContain("peer-by-literal");
  });

  it("classifies a structural violation as error and a host literal as warning", () => {
    const structural = spec([
      svc({ name: "web", port: 3000, needs: [], env: { API_URL: "http://{{api}}" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(checkPortability(structural).find((i) => i.rule === "needs-complete")?.severity).toBe("error");

    const hostLiteral = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]);
    expect(checkPortability(hostLiteral).find((i) => i.rule === "no-literal-host")?.severity).toBe("warning");
  });
});

describe("assertPortable", () => {
  it("throws on a structural error (a peer addressed by its literal name)", () => {
    const s = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://api:4000" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(() => assertPortable(s)).toThrow(BadRequestError);
  });

  it("does NOT throw on a host-literal-only spec (a warning is surfaced, not blocked)", () => {
    const s = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]);
    expect(() => assertPortable(s)).not.toThrow();
  });

  it("does not touch a non-service spec", () => {
    expect(() => assertPortable({ kind: "process", id: "cc", version: "1" })).not.toThrow();
  });
});
