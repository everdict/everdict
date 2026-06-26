import type { ServiceHarnessSpec, TrustZone } from "@assay/core";
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
    { store: "postgres", role: "checkpoints", isolateBy: "thread_id" },
    { store: "redis", role: "broker", isolateBy: "key-prefix" },
  ],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
const zone = (over: Partial<TrustZone>): TrustZone => ({
  id: "acme",
  isolationRuntime: "runsc",
  namespace: "assay-acme",
  network: "deny-cross-tenant",
  trusted: false,
  ...over,
});

describe("resolveStoreIsolation", () => {
  it("미지정: trusted→pool, untrusted→silo, zone 없음→silo", () => {
    expect(resolveStoreIsolation(zone({ trusted: true }))).toBe("pool");
    expect(resolveStoreIsolation(zone({ trusted: false }))).toBe("silo");
    expect(resolveStoreIsolation(undefined)).toBe("silo");
  });
  it("명시 storeIsolation 이 파생을 이긴다", () => {
    expect(resolveStoreIsolation(zone({ trusted: false, storeIsolation: "pool" }))).toBe("pool");
    expect(resolveStoreIsolation(zone({ trusted: true, storeIsolation: "silo" }))).toBe("silo");
  });
});

describe("sanitizeIdent", () => {
  it("안전한 슬러그는 그대로", () => {
    expect(sanitizeIdent("acme")).toBe("acme");
  });
  it("불안전 문자는 _ 로 + 변형 시 해시 접미(충돌 방지), 항상 [a-z0-9_]", () => {
    const a = sanitizeIdent("Acme-Co!");
    expect(a).toMatch(/^[a-z0-9_]+$/);
    expect(sanitizeIdent("Acme-Co!")).toBe(a); // 결정적
    expect(sanitizeIdent("acme-co?")).not.toBe(a); // 다른 원본 → 다른 해시
  });
});

describe("planTenantStores — pool", () => {
  const plan = planTenantStores(SPEC, zone({ storeIsolation: "pool" }));

  it("postgres: 전용 DB+role 로 scoped DATABASE_URL(공유 스토어 DNS)", () => {
    expect(plan.serviceEnv.DATABASE_URL).toMatch(
      /^postgresql:\/\/r_acme:.+@assay-shared-postgres\.assay-shared\.svc\.cluster\.local:5432\/tenant_acme$/,
    );
    const pg = plan.tenants.find((t) => t.store === "postgres");
    expect(pg?.database).toBe("tenant_acme");
    expect(pg?.role).toBe("r_acme");
    // 교차차단의 핵심: 전용 role 생성 + PUBLIC CONNECT 회수.
    expect(pg?.postgresSetup).toContain("CREATE ROLE r_acme");
    expect(pg?.postgresSetup).toContain("CREATE DATABASE tenant_acme");
    expect(pg?.postgresSetup).toContain("REVOKE CONNECT ON DATABASE tenant_acme FROM PUBLIC");
  });

  it("redis: ACL user + key-prefix 네임스페이스 + scoped REDIS_URL", () => {
    expect(plan.serviceEnv.REDIS_URL).toMatch(/^redis:\/\/acme:.+@assay-shared-redis\.assay-shared\..+:6379$/);
    expect(plan.serviceEnv.REDIS_KEY_PREFIX).toBe("t:acme:");
    const redis = plan.tenants.find((t) => t.store === "redis");
    expect(redis?.redisSetup?.[0]).toEqual(
      expect.arrayContaining(["ACL", "SETUSER", "acme", "~t:acme:*", "+@all", "-@dangerous"]),
    );
  });

  it("storeEndpoint 주입 시 그 host:port 로 접속 URL 생성(Nomad 런타임 발견 host:port)", () => {
    const np = planTenantStores(SPEC, zone({ storeIsolation: "pool" }), {
      storeEndpoint: (store) => (store === "postgres" ? "10.0.0.7:35432" : "10.0.0.7:36379"),
    });
    expect(np.serviceEnv.DATABASE_URL).toContain("@10.0.0.7:35432/tenant_acme"); // K8s DNS 대신 주입 host:port
    expect(np.serviceEnv.REDIS_URL).toContain("@10.0.0.7:36379");
  });

  it("비밀번호는 시드 결정적(idempotent), 테넌트마다 다른 DB(테넌트 경계)", () => {
    const again = planTenantStores(SPEC, zone({ storeIsolation: "pool" }));
    expect(again.serviceEnv.DATABASE_URL).toBe(plan.serviceEnv.DATABASE_URL); // 동일 시드 → 동일
    const other = planTenantStores(SPEC, zone({ id: "globex", storeIsolation: "pool" }));
    expect(other.tenants.find((t) => t.store === "postgres")?.database).toBe("tenant_globex");
    expect(other.serviceEnv.DATABASE_URL).not.toBe(plan.serviceEnv.DATABASE_URL); // 다른 테넌트 → 다른 creds/DB
  });
});

describe("planTenantStores — minio pool", () => {
  const MINIO_SPEC: ServiceHarnessSpec = {
    ...SPEC,
    dependencies: [{ store: "minio", role: "snapshots", isolateBy: "object-prefix" }],
  };
  const plan = planTenantStores(MINIO_SPEC, zone({ storeIsolation: "pool" }));

  it("테넌트 전용 access key + 버킷 + 버킷-한정 정책(scoped creds)", () => {
    expect(plan.serviceEnv.AWS_ACCESS_KEY_ID).toBe("t-acme");
    expect(plan.serviceEnv.S3_BUCKET).toBe("tenant-acme");
    expect(plan.serviceEnv.AWS_S3_ENDPOINT).toMatch(/^http:\/\/assay-shared-minio\.assay-shared\..+:9000$/);
    const minio = plan.tenants.find((t) => t.store === "minio");
    expect(minio?.minioSetup).toContain("mc mb -p local/tenant-acme");
    expect(minio?.minioSetup).toContain("mc admin user add local t-acme");
    // 정책은 그 버킷만 허용(교차차단의 핵심).
    expect(minio?.minioSetup).toContain("arn:aws:s3:::tenant-acme");
    expect(minio?.minioSetup).toContain("mc admin policy attach local p-acme --user t-acme");
  });
});

describe("planTenantStores — silo / external", () => {
  it("silo: 전용 스토어 connEnv(케이스별 격리는 builder), provisioning 없음", () => {
    const plan = planTenantStores(SPEC, zone({ storeIsolation: "silo" }));
    expect(plan.tenants).toHaveLength(0);
    expect(plan.serviceEnv.DATABASE_URL).toBe("postgresql://assay:assay@aegra-postgres:5432/assay");
  });
  it("external: 스토어 env 없음(BYO storeEnv 가 담당)", () => {
    const plan = planTenantStores(SPEC, zone({ storeIsolation: "external" }));
    expect(plan.tenants).toHaveLength(0);
    expect(plan.serviceEnv).toEqual({});
  });
});
