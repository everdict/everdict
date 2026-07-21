import { BadRequestError, type ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { StoreValues } from "./dependencies.js";
import { dependencyInjectEnv, renderInjectTemplate } from "./inject-env.js";

// Dependency env injection — the store-side sibling of service.wiring: a third-party image that reads its store
// connection under ITS OWN names (VALKEY_URL / OBJECT_STORAGE_ENDPOINT) gets them rendered from the coordinates of the
// store the runtime ACTUALLY deployed, instead of staring at a stale service.env literal.

const redis: StoreValues = {
  host: "acme-redis",
  port: "6379",
  endpoint: "acme-redis:6379",
  url: "redis://acme-redis:6379",
};

const pooledRedis: StoreValues = {
  ...redis,
  user: "acme",
  password: "pw",
  userinfo: "acme:pw@",
  keyPrefix: "t:acme:",
  url: "redis://acme:pw@acme-redis:6379",
};

const spec = (over: Partial<ServiceHarnessSpec>): ServiceHarnessSpec => ({
  kind: "service",
  id: "spica",
  version: "1",
  services: [
    { name: "app", image: "spica:1", needs: [], perRun: [], replicas: 1, env: {} },
    { name: "worker", image: "spica-worker:1", needs: [], perRun: [], replicas: 1, env: {} },
  ],
  dependencies: [],
  frontDoor: { service: "app", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  ...over,
});

describe("renderInjectTemplate", () => {
  it("renders a {field} template from the store coordinates", () => {
    expect(renderInjectTemplate("redis", "valkey://{host}:{port}", redis)).toBe("valkey://acme-redis:6379");
  });

  it("renders a field the isolation model did not mint as empty — one template covers open and authenticated stores", () => {
    expect(renderInjectTemplate("redis", "valkey://{userinfo}{host}:{port}", redis)).toBe("valkey://acme-redis:6379");
    expect(renderInjectTemplate("redis", "valkey://{userinfo}{host}:{port}", pooledRedis)).toBe(
      "valkey://acme:pw@acme-redis:6379",
    );
  });

  it("throws BadRequestError on a field outside the store vocabulary (defense in depth under the schema check)", () => {
    expect(() => renderInjectTemplate("redis", "redis://{host}/{bucket}", redis)).toThrow(BadRequestError);
  });
});

describe("dependencyInjectEnv", () => {
  it("renders every inject mapping of a deployed store (default template = the canonical {url})", () => {
    const s = spec({
      dependencies: [
        {
          store: "redis",
          role: "queue",
          isolateBy: "key-prefix",
          inject: [{ env: "VALKEY_URL" }, { env: "QUEUE_HOST", template: "{host}" }],
        },
      ],
    });
    expect(dependencyInjectEnv(s, { redis: pooledRedis }, "app")).toEqual({
      VALKEY_URL: "redis://acme:pw@acme-redis:6379",
      QUEUE_HOST: "acme-redis",
    });
  });

  it("scopes by dep.service — unset injects into every service, set injects into that service only", () => {
    const s = spec({
      dependencies: [
        { store: "redis", role: "queue", isolateBy: "key-prefix", service: "worker", inject: [{ env: "VALKEY_URL" }] },
      ],
    });
    expect(dependencyInjectEnv(s, { redis: redis }, "app")).toEqual({});
    expect(dependencyInjectEnv(s, { redis: redis }, "worker")).toEqual({ VALKEY_URL: "redis://acme-redis:6379" });
  });

  it("skips an external dependency (Everdict deployed nothing — no coordinates) and a store with no values", () => {
    const s = spec({
      dependencies: [
        { store: "minio", role: "artifacts", isolateBy: "external", inject: [{ env: "OBJECT_STORAGE_ENDPOINT" }] },
        { store: "postgres", role: "state", isolateBy: "schema", inject: [{ env: "PG_URL" }] },
      ],
    });
    // postgres has no entry in storeValues (this runtime configuration deployed no store) → nothing rendered.
    expect(dependencyInjectEnv(s, {}, "app")).toEqual({});
  });

  it("renders nothing for a dependency without inject mappings (conventional connEnv keys remain the only injection)", () => {
    const s = spec({ dependencies: [{ store: "redis", role: "queue", isolateBy: "key-prefix" }] });
    expect(dependencyInjectEnv(s, { redis: redis }, "app")).toEqual({});
  });
});
