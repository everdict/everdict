import { createHmac } from "node:crypto";
import type { ServiceHarnessSpec, TrustZone } from "@assay/core";
import { STORE_DEFS, dependencyConnEnv, dependencyStores } from "./dependencies.js";

// 공유 스토어의 테넌트 격리 모델.
//   pool     = 공유 PG/Redis 1대 + 테넌트별 논리격리(전용 DATABASE+role / Redis ACL user+key-prefix) + scoped creds.
//              "성능 위해 최소한만 관리되는 공유 인프라" — 핫패스는 싼 논리객체(DB/role/ACL)만 mint, DB 엔진은 안 띄움.
//   silo     = 테넌트마다 전용 스토어 인스턴스(SLICE 39, provisionDependencies). 강격리·고비용 — untrusted/컴플라이언스.
//   external = BYO 엔드포인트(storeEnv). 스토어 미배포.
// 주의: isolateBy(thread_id/key-prefix)는 *한 테넌트의 케이스끼리* 분리 — 테넌트 경계가 아니다.
//       테넌트 경계 = DB/role/ACL/creds(+권장 NetworkPolicy). pool 의 핵심.
export type StoreIsolation = "pool" | "silo" | "external";

// 존이 명시 안 하면 trusted→pool(공유+논리), untrusted→silo(전용, 적대 코드 폭발반경 최소화).
export function resolveStoreIsolation(zone?: TrustZone): StoreIsolation {
  if (zone?.storeIsolation) return zone.storeIsolation;
  return zone?.trusted ? "pool" : "silo";
}

export interface StoreBindingOptions {
  poolNamespace?: string; // 공유 스토어가 사는 네임스페이스 (기본 "assay-shared")
  storeSecret?: string; // 테넌트별 비밀번호 mint 시드(프로덕션: KEK/Vault). 동일 시드→idempotent.
  // 스토어 접속 엔드포인트("host:port") 해석 — orchestrator 별로 다름:
  //   K8s = 안정적 Service DNS(빌드타임 확정, 기본값), Nomad = 런타임에 발견한 alloc host:port(주입).
  storeEndpoint?: (store: string) => string;
}

const DEFAULT_POOL_NS = "assay-shared";
const DEFAULT_SECRET = "assay-dev-store-secret";

// 공유 스토어 배포명(= Service DNS). pool 은 (harness/zone 무관) 클러스터에 1대만.
export function sharedStoreName(store: string): string {
  return `assay-shared-${store}`;
}
function sharedStoreHost(store: string, poolNs: string): string {
  return `${sharedStoreName(store)}.${poolNs}.svc.cluster.local`;
}

// SQL/Redis 식별자 안전화: [a-z0-9_] 만, 첫 글자 보장. 다른 zone-id 충돌 방지로 변형 시 해시 접미.
export function sanitizeIdent(raw: string): string {
  const san = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 40);
  const base = /^[a-z_]/.test(san) ? san : `t_${san}`;
  if (base === raw.toLowerCase()) return base;
  const h = createHmac("sha256", "ident").update(raw).digest("hex").slice(0, 6);
  return `${base}_${h}`;
}

function mintPassword(secret: string, zoneId: string, store: string): string {
  return createHmac("sha256", secret).update(`${zoneId}:${store}`).digest("base64url").slice(0, 24);
}

// pool 일 때 공유 스토어에 실행할 idempotent provisioning + 서비스에 줄 scoped 접속 env.
export interface TenantStorePlan {
  store: string;
  database?: string; // postgres 전용 DB
  role?: string; // postgres 전용 role
  keyPrefix?: string; // redis 키 네임스페이스
  aclUser?: string; // redis ACL user
  env: Record<string, string>; // 서비스 주입(scoped creds)
  postgresSetup?: string; // pg 어드민에서 psql -f - 로 실행할 스크립트(idempotent)
  redisSetup?: string[][]; // redis-cli 인자 배열들(idempotent)
}

export interface StorePlan {
  isolation: StoreIsolation;
  serviceEnv: Record<string, string>; // services 에 주입할 스토어 접속 env(병합)
  tenants: TenantStorePlan[]; // pool 일 때 실행할 per-store provisioning (silo/external 은 빈 배열)
}

// 테넌트(zone) 스토어 계획 — 순수. 런타임이 이걸로 공유 스토어에 DDL/ACL 실행 + 서비스 env 주입.
export function planTenantStores(
  spec: ServiceHarnessSpec,
  zone: TrustZone | undefined,
  opts: StoreBindingOptions = {},
): StorePlan {
  const isolation = resolveStoreIsolation(zone);
  if (isolation === "silo") {
    // SLICE 39: 전용 스토어를 zone ns 에 배포(빌더가 connEnv 자동) — 여기선 env 만 동일하게 노출.
    return { isolation, serviceEnv: dependencyConnEnv(spec), tenants: [] };
  }
  if (isolation === "external") return { isolation, serviceEnv: {}, tenants: [] };

  // pool: 공유 스토어 + 테넌트별 논리격리.
  const poolNs = opts.poolNamespace ?? DEFAULT_POOL_NS;
  const secret = opts.storeSecret ?? DEFAULT_SECRET;
  const zoneId = zone?.id ?? "default";
  const slug = sanitizeIdent(zoneId);
  const serviceEnv: Record<string, string> = {};
  const tenants: TenantStorePlan[] = [];
  // 기본 엔드포인트 = K8s Service DNS:port. Nomad 는 opts.storeEndpoint 로 발견한 host:port 주입.
  const endpointFor = (store: string): string =>
    opts.storeEndpoint?.(store) ?? `${sharedStoreHost(store, poolNs)}:${STORE_DEFS[store]?.port ?? 0}`;

  for (const { store } of dependencyStores(spec)) {
    const pw = mintPassword(secret, zoneId, store);
    if (store === "postgres") {
      const database = `tenant_${slug}`;
      const role = `r_${slug}`;
      const endpoint = endpointFor("postgres");
      const env = { DATABASE_URL: `postgresql://${role}:${pw}@${endpoint}/${database}` };
      Object.assign(serviceEnv, env);
      tenants.push({
        store,
        database,
        role,
        env,
        // 전용 DB + 비-superuser role. PUBLIC 의 CONNECT 회수 → 다른 테넌트 role 은 접속 거부(교차차단의 핵심).
        postgresSetup: [
          "DO $$ BEGIN",
          `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN`,
          `    CREATE ROLE ${role} LOGIN PASSWORD '${pw}';`,
          `  ELSE ALTER ROLE ${role} LOGIN PASSWORD '${pw}'; END IF;`,
          "END $$;",
          `SELECT 'CREATE DATABASE ${database} OWNER ${role}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${database}')\\gexec`,
          `REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;`,
          `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
          "",
        ].join("\n"),
      });
    } else if (store === "redis") {
      const aclUser = slug;
      const keyPrefix = `t:${slug}:`;
      const endpoint = endpointFor("redis");
      // 접속 URL 은 ACL user 로, 키는 prefix 네임스페이스(케이스별 isolateBy 가 그 아래 중첩).
      const env = {
        REDIS_URL: `redis://${aclUser}:${pw}@${endpoint}`,
        REDIS_URI: `redis://${aclUser}:${pw}@${endpoint}`,
        REDIS_KEY_PREFIX: keyPrefix,
      };
      Object.assign(serviceEnv, env);
      tenants.push({
        store,
        aclUser,
        keyPrefix,
        env,
        // ACL: 이 user 는 자기 prefix 키만(+@all -@dangerous), 비번 필요. 교차 prefix 접근은 NOPERM.
        redisSetup: [["ACL", "SETUSER", aclUser, "on", `>${pw}`, `~${keyPrefix}*`, "+@all", "-@dangerous"]],
      });
    }
  }
  return { isolation, serviceEnv, tenants };
}

export { DEFAULT_POOL_NS, sharedStoreHost };
