import { collectAuthEnv } from "@assay/agent";
import {
  BackendRegistry,
  type BudgetLimit,
  LocalBackend,
  NomadBackend,
  Scheduler,
  inMemoryBudget,
} from "@assay/backends";
import { InMemoryRunStore, PgRunStore, type RunStore, makePool, migrate, sqlClient } from "@assay/db";
import { RunService } from "./run-service.js";
import { buildServer } from "./server.js";

// 기본 컨트롤플레인 서버. NOMAD_ADDR 가 있으면 Nomad 백엔드, 아니면 in-process Local.
// 스케줄러(용량인지+공정+오토스케일 가능)를 디스패처로, in-memory 결과 스토어를 쓴다.
// 운영: 결과 스토어를 Postgres/ClickHouse 구현으로 교체하고, 백엔드 레지스트리를 backends-config 로 선언.
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "8787");
  const nomadAddr = process.env.NOMAD_ADDR;
  const image = process.env.ASSAY_AGENT_IMAGE;

  const registry = new BackendRegistry();
  if (nomadAddr && image) {
    registry.register("nomad", new NomadBackend({ addr: nomadAddr, image, secretEnv: collectAuthEnv() }));
  } else {
    registry.register("local", new LocalBackend());
  }
  const scheduler = new Scheduler(registry);

  // 데모용 테넌트 예산 — 운영에선 테넌트 DB/플랜에서 조회.
  const budget = inMemoryBudget({ limitFor: budgetFromEnv() });

  // 결과 스토어: DATABASE_URL 이 있으면 Postgres(마이그레이션 후), 아니면 in-memory.
  const store = await makeStore();

  const service = new RunService({ dispatcher: scheduler, store, budget });
  const app = buildServer({ service });

  await app.listen({ port, host: "0.0.0.0" });
  console.error(
    `▶ assay-api on :${port}  (backend: ${nomadAddr ? "nomad" : "local"}, store: ${process.env.DATABASE_URL ? "postgres" : "memory"})`,
  );
}

// DATABASE_URL 이 있으면 Postgres 스토어(기동 시 마이그레이션 적용), 없으면 in-memory.
async function makeStore(): Promise<RunStore> {
  const url = process.env.DATABASE_URL;
  if (!url) return new InMemoryRunStore();
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  return new PgRunStore(client);
}

// ASSAY_TENANT_RUNS / ASSAY_TENANT_USD 로 모든 테넌트에 동일 상한(데모). 미설정이면 무제한.
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
