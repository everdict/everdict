import type { ServiceHarnessSpec, TrustZone } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { planTenantStores, resolveStoreIsolation, sanitizeIdent } from "./store-binding.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "aegra",
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "aegra:1", port: 2026, needs: [], perRun: ["thread_id"], replicas: 1, env: {} },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", purpose: "plumbing", isolateBy: "thread_id" },
    { store: "redis", role: "broker", purpose: "plumbing", isolateBy: "key-prefix" },
  ],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
const zone = (over: Partial<TrustZone>): TrustZone => ({
  id: "acme",
  isolationRuntime: "runsc",
  namespace: "everdict-acme",
  network: "deny-cross-tenant",
  trusted: false,
  ...over,
});

describe("resolveStoreIsolation", () => {
  it("unspecified: trusted→pool, untrusted→silo, no zone→silo", () => {
    expect(resolveStoreIsolation(zone({ trusted: true }))).toBe("pool");
    expect(resolveStoreIsolation(zone({ trusted: false }))).toBe("silo");
    expect(resolveStoreIsolation(undefined)).toBe("silo");
  });
  it("an explicit storeIsolation wins over the derivation", () => {
    expect(resolveStoreIsolation(zone({ trusted: false, storeIsolation: "pool" }))).toBe("pool");
    expect(resolveStoreIsolation(zone({ trusted: true, storeIsolation: "silo" }))).toBe("silo");
  });
});

describe("sanitizeIdent", () => {
  it("a safe slug is left as-is", () => {
    expect(sanitizeIdent("acme")).toBe("acme");
  });
  it("unsafe characters → _ + a hash suffix when altered (collision avoidance), always [a-z0-9_]", () => {
    const a = sanitizeIdent("Acme-Co!");
    expect(a).toMatch(/^[a-z0-9_]+$/);
    expect(sanitizeIdent("Acme-Co!")).toBe(a); // deterministic
    expect(sanitizeIdent("acme-co?")).not.toBe(a); // different input → different hash
  });
});

describe("planTenantStores — pool", () => {
  const plan = planTenantStores(SPEC, zone({ storeIsolation: "pool" }));

  it("postgres: a scoped DATABASE_URL with a dedicated DB+role (shared-store DNS)", () => {
    expect(plan.serviceEnv.DATABASE_URL).toMatch(
      /^postgresql:\/\/r_acme:.+@everdict-shared-postgres\.everdict-shared\.svc\.cluster\.local:5432\/tenant_acme$/,
    );
    const pg = plan.tenants.find((t) => t.store === "postgres");
    expect(pg?.database).toBe("tenant_acme");
    expect(pg?.role).toBe("r_acme");
    // The core of cross-blocking: create a dedicated role + revoke PUBLIC CONNECT.
    expect(pg?.postgresSetup).toContain("CREATE ROLE r_acme");
    expect(pg?.postgresSetup).toContain("CREATE DATABASE tenant_acme");
    expect(pg?.postgresSetup).toContain("REVOKE CONNECT ON DATABASE tenant_acme FROM PUBLIC");
  });

  it("redis: ACL user + key-prefix namespace + scoped REDIS_URL", () => {
    expect(plan.serviceEnv.REDIS_URL).toMatch(/^redis:\/\/acme:.+@everdict-shared-redis\.everdict-shared\..+:6379$/);
    expect(plan.serviceEnv.REDIS_KEY_PREFIX).toBe("t:acme:");
    const redis = plan.tenants.find((t) => t.store === "redis");
    expect(redis?.redisSetup?.[0]).toEqual(
      expect.arrayContaining(["ACL", "SETUSER", "acme", "~t:acme:*", "+@all", "-@dangerous"]),
    );
  });

  it("with storeEndpoint injected, builds the connection URL from that host:port (Nomad runtime-discovered host:port)", () => {
    const np = planTenantStores(SPEC, zone({ storeIsolation: "pool" }), {
      storeEndpoint: (store) => (store === "postgres" ? "10.0.0.7:35432" : "10.0.0.7:36379"),
    });
    expect(np.serviceEnv.DATABASE_URL).toContain("@10.0.0.7:35432/tenant_acme"); // injected host:port instead of K8s DNS
    expect(np.serviceEnv.REDIS_URL).toContain("@10.0.0.7:36379");
  });

  it("exposes the SAME minted coordinates structured (storeValues) — what dependencies[].inject templates render from", () => {
    // serviceEnv is the conventional-key rendering; storeValues carries the pieces so a BYO template can recompose them.
    expect(plan.storeValues.postgres?.user).toBe("r_acme");
    expect(plan.storeValues.postgres?.database).toBe("tenant_acme");
    expect(plan.storeValues.postgres?.url).toBe(plan.serviceEnv.DATABASE_URL);
    expect(plan.storeValues.redis?.user).toBe("acme");
    expect(plan.storeValues.redis?.keyPrefix).toBe("t:acme:");
    expect(plan.storeValues.redis?.url).toBe(plan.serviceEnv.REDIS_URL);
    expect(plan.storeValues.redis?.userinfo).toMatch(/^acme:.+@$/);
  });

  it("the password is seed-deterministic (idempotent), and each tenant gets a different DB (tenant boundary)", () => {
    const again = planTenantStores(SPEC, zone({ storeIsolation: "pool" }));
    expect(again.serviceEnv.DATABASE_URL).toBe(plan.serviceEnv.DATABASE_URL); // same seed → same
    const other = planTenantStores(SPEC, zone({ id: "globex", storeIsolation: "pool" }));
    expect(other.tenants.find((t) => t.store === "postgres")?.database).toBe("tenant_globex");
    expect(other.serviceEnv.DATABASE_URL).not.toBe(plan.serviceEnv.DATABASE_URL); // different tenant → different creds/DB
  });
});

describe("planTenantStores — minio pool", () => {
  const MINIO_SPEC: ServiceHarnessSpec = {
    ...SPEC,
    dependencies: [{ store: "minio", role: "snapshots", purpose: "plumbing", isolateBy: "object-prefix" }],
  };
  const plan = planTenantStores(MINIO_SPEC, zone({ storeIsolation: "pool" }));

  it("per-tenant access key + bucket + bucket-scoped policy (scoped creds)", () => {
    expect(plan.serviceEnv.AWS_ACCESS_KEY_ID).toBe("t-acme");
    expect(plan.serviceEnv.S3_BUCKET).toBe("tenant-acme");
    expect(plan.serviceEnv.AWS_S3_ENDPOINT).toMatch(/^http:\/\/everdict-shared-minio\.everdict-shared\..+:9000$/);
    const minio = plan.tenants.find((t) => t.store === "minio");
    expect(minio?.minioSetup).toContain("mc mb -p local/tenant-acme");
    expect(minio?.minioSetup).toContain("mc admin user add local t-acme");
    // The policy allows only that bucket (the core of cross-blocking).
    expect(minio?.minioSetup).toContain("arn:aws:s3:::tenant-acme");
    expect(minio?.minioSetup).toContain("mc admin policy attach local p-acme --user t-acme");
  });
});

describe("planTenantStores — silo / external", () => {
  it("silo: dedicated-store connEnv (per-case isolation is the builder's job), no provisioning", () => {
    const plan = planTenantStores(SPEC, zone({ storeIsolation: "silo" }));
    expect(plan.tenants).toHaveLength(0);
    expect(plan.serviceEnv.DATABASE_URL).toBe("postgresql://everdict:everdict@aegra-postgres:5432/everdict");
    // Build-time default coordinates (root creds) — silo inject templates render from these.
    expect(plan.storeValues.postgres?.url).toBe(plan.serviceEnv.DATABASE_URL);
    expect(plan.storeValues.redis?.url).toBe("redis://aegra-redis:6379");
    expect(plan.storeValues.redis?.userinfo).toBeUndefined(); // open silo redis — {userinfo} renders empty
  });
  it("external: no store env (BYO storeEnv handles it)", () => {
    const plan = planTenantStores(SPEC, zone({ storeIsolation: "external" }));
    expect(plan.tenants).toHaveLength(0);
    expect(plan.serviceEnv).toEqual({});
    expect(plan.storeValues).toEqual({}); // nothing deployed → nothing to render
  });
});
