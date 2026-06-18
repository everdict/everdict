import { collectAuthEnv } from "@assay/agent";
import {
  BackendRegistry,
  type BudgetLimit,
  LocalBackend,
  NomadBackend,
  Scheduler,
  inMemoryBudget,
} from "@assay/backends";
import {
  InMemoryRunStore,
  InMemoryTenantKeyStore,
  PgRunStore,
  PgTenantKeyStore,
  type RunStore,
  type TenantKeyStore,
  keyStoreAuth,
  makePool,
  migrate,
  sqlClient,
} from "@assay/db";
import { type HarnessRegistry, InMemoryHarnessRegistry, PgHarnessRegistry } from "@assay/registry";
import { RunService } from "./run-service.js";
import { buildServer } from "./server.js";

// 멀티테넌트 컨트롤플레인 서버. tenant 는 Bearer API 키에서 파생(없으면 dev 헤더 폴백).
// DATABASE_URL 이 있으면 Postgres(스토어/키/레지스트리), 아니면 in-memory. NOMAD_ADDR 면 Nomad 백엔드.
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "8787");
  const nomadAddr = process.env.NOMAD_ADDR;
  const image = process.env.ASSAY_AGENT_IMAGE;

  const backends = new BackendRegistry();
  if (nomadAddr && image) {
    backends.register("nomad", new NomadBackend({ addr: nomadAddr, image, secretEnv: collectAuthEnv() }));
  } else {
    backends.register("local", new LocalBackend());
  }
  const scheduler = new Scheduler(backends);
  const budget = inMemoryBudget({ limitFor: budgetFromEnv() });

  const { store, keyStore, registry } = await makePersistence();
  const service = new RunService({ dispatcher: scheduler, store, budget });
  const app = buildServer({
    service,
    registry,
    auth: keyStoreAuth(keyStore),
    keyStore,
    internalToken: process.env.ASSAY_INTERNAL_TOKEN,
    requireAuth: process.env.ASSAY_REQUIRE_AUTH === "1",
  });

  await app.listen({ port, host: "0.0.0.0" });
  console.error(
    `▶ assay-api on :${port} (backend:${nomadAddr ? "nomad" : "local"} store:${process.env.DATABASE_URL ? "postgres" : "memory"} auth:${process.env.ASSAY_REQUIRE_AUTH === "1" ? "required" : "dev-fallback"})`,
  );
}

interface Persistence {
  store: RunStore;
  keyStore: TenantKeyStore;
  registry: HarnessRegistry;
}

// DATABASE_URL 이 있으면 Postgres(기동 시 마이그레이션 적용), 없으면 in-memory.
async function makePersistence(): Promise<Persistence> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return {
      store: new InMemoryRunStore(),
      keyStore: new InMemoryTenantKeyStore(),
      registry: new InMemoryHarnessRegistry(),
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  return {
    store: new PgRunStore(client),
    keyStore: new PgTenantKeyStore(client),
    registry: new PgHarnessRegistry(client),
  };
}

function budgetFromEnv(): (tenant: string) => BudgetLimit | undefined {
  const runs = process.env.ASSAY_TENANT_RUNS ? Number(process.env.ASSAY_TENANT_RUNS) : undefined;
  const usd = process.env.ASSAY_TENANT_USD ? Number(process.env.ASSAY_TENANT_USD) : undefined;
  if (runs === undefined && usd === undefined) return () => undefined;
  const limit: BudgetLimit = { ...(runs !== undefined ? { runs } : {}), ...(usd !== undefined ? { usd } : {}) };
  return () => limit;
}

main().catch((err) => {
  console.error("assay-api failed to start:", err);
  process.exit(1);
});
