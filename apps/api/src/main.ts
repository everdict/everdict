import { collectAuthEnv } from "@assay/agent";
import {
  BackendRegistry,
  type BudgetLimit,
  LocalBackend,
  NomadBackend,
  Scheduler,
  inMemoryBudget,
} from "@assay/backends";
import { RunService } from "./run-service.js";
import { InMemoryRunStore } from "./run-store.js";
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

  const service = new RunService({ dispatcher: scheduler, store: new InMemoryRunStore(), budget });
  const app = buildServer({ service });

  await app.listen({ port, host: "0.0.0.0" });
  console.error(`▶ assay-api on :${port}  (backend: ${nomadAddr ? "nomad" : "local"})`);
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
