import { BadRequestError, type ServiceHarnessSpec, type TopologyService } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type PortabilityRule, assertPortable, checkPortability, contextIdUnread } from "./portability.js";

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

  // gap 7: a hardcoded foreign container/store DNS name (not a declared peer, not loopback/IP) is docker-only.
  it("flags a hardcoded foreign store DNS host:port in service env as a warning (surfaced, not blocked)", () => {
    const s = spec([svc({ name: "app", port: 3000, env: { VALKEY_URL: "redis://super-spica-redis:6379" } })]);
    const issue = checkPortability(s).find((i) => i.rule === "store-by-literal");
    expect(issue?.severity).toBe("warning"); // preserves the self-hosted-only escape hatch
    expect(issue?.message).toContain("super-spica-redis");
    expect(() => assertPortable(s)).not.toThrow(); // a warning never blocks registration
  });

  it("does NOT store-by-literal a declared peer, a loopback host, or a multi-label FQDN", () => {
    const peer = spec([
      svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://api:4000" } }),
      svc({ name: "api", port: 4000 }),
    ]);
    expect(rules(peer)).not.toContain("store-by-literal"); // a declared peer is peer-by-literal (error), not this
    const fqdn = spec([svc({ name: "web", port: 3000, env: { API_URL: "https://api.github.com:443/x" } })]);
    expect(rules(fqdn)).not.toContain("store-by-literal"); // a real internet host is portable
    const loop = spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]);
    expect(rules(loop)).not.toContain("store-by-literal"); // loopback is no-literal-host
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

// ── TWO CAPABILITIES THAT CANNOT BE COMBINED (downstream report 5.2) ─────────────────────────────────
describe("profile-uninjectable — a declared login with no channel to inject it through", () => {
  const target = (over: Partial<NonNullable<ServiceHarnessSpec["target"]>> = {}) =>
    ({
      kind: "browser" as const,
      engine: "chromium" as const,
      lifecycle: "per-case-instance" as const,
      observe: ["dom" as const],
      ...over,
    }) as NonNullable<ServiceHarnessSpec["target"]>;

  const sessionAcquire = {
    mode: "service" as const,
    service: "sessions",
    open: "POST /sessions",
    coordinates: { target_cdp_url: "cdp_url" },
  };

  it("warns when a profile rides a service-acquired target with no cdpBase — it would be silently ignored", () => {
    const s = spec([svc({ name: "sessions", port: 8000 })], {
      target: target({ profile: "acme-login", acquire: sessionAcquire }),
    });
    const issue = checkPortability(s).find((i) => i.rule === "profile-uninjectable");
    expect(issue?.severity).toBe("warning"); // the topology IS portable; the login is not, and that may be intended
    expect(issue?.message).toContain("acquire.cdpBase");
    // …and it must not block a registration: an author may well intend the agent to log itself in.
    expect(() => assertPortable(s)).not.toThrow();
  });

  it("says nothing when the session response declares a cdpBase, or when the browser is ours to provision", () => {
    const withBase = spec([svc({ name: "sessions", port: 8000 })], {
      target: target({ profile: "acme-login", acquire: { ...sessionAcquire, cdpBase: "cdp_http" } }),
    });
    expect(rules(withBase)).not.toContain("profile-uninjectable");
    const provisioned = spec([svc({ name: "agent", port: 8000 })], { target: target({ profile: "acme-login" }) });
    expect(rules(provisioned)).not.toContain("profile-uninjectable");
  });
});

// ── A DECLARATION THE FRAMEWORK CANNOT ACT ON IS SURFACED, NEVER IGNORED (downstream report 3.1) ─────
describe("host-program-undelivered — a host-exec service whose program nothing delivers", () => {
  const hostSvc = (over: Partial<TopologyService> = {}): TopologyService => {
    const base = svc({ name: "win-ui", port: 9515, exec: { kind: "host", command: ["C:/drivers/ui-driver.exe"] } });
    const { image: _image, ...withoutImage } = base; // a host-exec service carries no image — nothing would run it
    return { ...withoutImage, ...over };
  };

  it("warns when a host-exec service declares no exec.artifact — the program is assumed pre-installed on the node", () => {
    const s = spec([hostSvc()]);
    const issue = checkPortability(s).find((i) => i.rule === "host-program-undelivered");
    expect(issue?.severity).toBe("warning"); // a golden image is a legitimate choice — visible, never blocked
    expect(issue?.field).toBe("services[win-ui].exec.artifact");
    expect(issue?.message).toMatch(/pre-installed/i);
    expect(() => assertPortable(s)).not.toThrow();
  });

  it("says nothing when the artifact is declared (either form), or for a containerized service", () => {
    const pinned = spec([
      hostSvc({ exec: { kind: "host", command: ["x"], artifact: "https://dl.example.com/x.zip" } }),
    ]);
    expect(rules(pinned)).not.toContain("host-program-undelivered");
    const container = spec([svc({ name: "web", port: 3000 })]); // its image IS the delivered program
    expect(rules(container)).not.toContain("host-program-undelivered");
  });
});

// ── A CONTROLLED COORDINATE NOBODY READS BACK (downstream report 3.2) ────────────────────────────────
describe("context-id-unread — frontDoor.contextId with a traceSource that never searches by it", () => {
  const withContext = (traceSource: ServiceHarnessSpec["traceSource"]) =>
    spec([svc({ name: "web", port: 3000 })], {
      frontDoor: { service: "web", submit: "POST /runs", contextId: "{{thread_id}}" },
      traceSource,
    });

  it("warns when the traceSource correlates by id (the default) — the harness submits under one coordinate, the platform polls another", () => {
    const s = withContext({ kind: "otel", endpoint: "http://otel.example.com" });
    const issue = checkPortability(s).find((i) => i.rule === "context-id-unread");
    expect(issue?.severity).toBe("warning");
    expect(issue?.field).toBe("frontDoor.contextId");
    // The message names both halves and the symptom: the timeout reads as a slow agent, not a wiring gap.
    expect(issue?.message).toContain("frontDoor.contextId");
    expect(issue?.message).toContain('correlate: "tag"');
    expect(issue?.message).toMatch(/slow agent/i);
    expect(() => assertPortable(s)).not.toThrow();
  });

  it('says nothing when the traceSource searches by tag (correlate: "tag" + correlateTag), or when no contextId is declared', () => {
    const paired = withContext({
      kind: "mlflow",
      endpoint: "http://mlflow.example.com",
      correlate: "tag",
      correlateTag: "mlflow.trace.session",
    });
    expect(rules(paired)).not.toContain("context-id-unread");
    const noContext = spec([svc({ name: "web", port: 3000 })]);
    expect(rules(noContext)).not.toContain("context-id-unread");
  });

  it("the warning and the shared predicate are the same decision — validation and behavior cannot fork", () => {
    const unread = withContext({ kind: "otel", endpoint: "http://otel.example.com" });
    const read = withContext({ kind: "otel", endpoint: "http://otel.example.com", correlate: "tag" });
    for (const s of [unread, read]) expect(rules(s).includes("context-id-unread")).toBe(contextIdUnread(s));
    // …and a template shape with no traceSource at all is still a total decision (unread).
    expect(contextIdUnread({ frontDoor: { service: "web", submit: "POST /runs", contextId: "{{thread_id}}" } })).toBe(
      true,
    );
  });
});

// ── THE ISSUE VOCABULARY, PARAMETERIZED — a new rule MUST place a producing fixture here ─────────────
// `satisfies Record<PortabilityRule, …>` makes the typecheck refuse a rule nobody can produce: extending the
// union without a fixture (or vice versa) fails to compile, so every rule in the vocabulary stays reachable.
const PRODUCED_BY_RULE = {
  "no-literal-host": spec([svc({ name: "web", port: 3000, env: { API_URL: "http://localhost:4000" } })]),
  "peer-by-literal": spec([
    svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://api:4000" } }),
    svc({ name: "api", port: 4000 }),
  ]),
  "needs-complete": spec([
    svc({ name: "web", port: 3000, needs: [], env: { API_URL: "http://{{api}}" } }),
    svc({ name: "api", port: 4000 }),
  ]),
  "addressed-has-port": spec([
    svc({ name: "web", port: 3000, needs: ["api"], env: { API_URL: "http://{{api}}" } }),
    svc({ name: "api" }),
  ]),
  "reference-not-address": spec([svc({ name: "web", port: 3000 })], {
    frontDoor: { service: "gateway", submit: "POST /runs" },
  }),
  "unique-ports": spec([svc({ name: "web", port: 3000 }), svc({ name: "api", port: 3000 })]),
  "artifact-store-internal": spec([svc({ name: "web", port: 3000 })], {
    dependencies: [{ store: "minio", role: "artifacts", purpose: "plumbing", isolateBy: "object-prefix" }],
  }),
  "inject-shadowed-literal": spec([svc({ name: "app", port: 3000, env: { VALKEY_URL: "redis://stale:6379" } })], {
    dependencies: [
      { store: "redis", role: "queue", purpose: "plumbing", isolateBy: "key-prefix", inject: [{ env: "VALKEY_URL" }] },
    ],
  }),
  "store-by-literal": spec([svc({ name: "app", port: 3000, env: { VALKEY_URL: "redis://super-spica-redis:6379" } })]),
  "profile-uninjectable": spec([svc({ name: "sessions", port: 8000 })], {
    target: {
      kind: "browser",
      engine: "chromium",
      lifecycle: "per-case-instance",
      observe: ["dom"],
      profile: "acme-login",
      acquire: {
        mode: "service",
        service: "sessions",
        open: "POST /sessions",
        coordinates: { target_cdp_url: "cdp_url" },
      },
    } as NonNullable<ServiceHarnessSpec["target"]>,
  }),
  "host-program-undelivered": spec([
    svc({ name: "win-ui", image: undefined, port: 9515, exec: { kind: "host", command: ["driver.exe"] } }),
  ]),
  "context-id-unread": spec([svc({ name: "web", port: 3000 })], {
    frontDoor: { service: "web", submit: "POST /runs", contextId: "{{thread_id}}" },
  }),
} satisfies Record<PortabilityRule, ServiceHarnessSpec>;

describe("the issue vocabulary is fully reachable — every rule has a spec that produces it", () => {
  it.each(Object.entries(PRODUCED_BY_RULE))(
    "%s is produced by its fixture, with a severity stamped",
    (rule, fixture) => {
      const issue = checkPortability(fixture).find((i) => i.rule === rule);
      expect(issue).toBeDefined();
      expect(issue?.severity === "error" || issue?.severity === "warning").toBe(true);
      expect(issue?.field.length).toBeGreaterThan(0);
      expect(issue?.message.length).toBeGreaterThan(0);
    },
  );
});
