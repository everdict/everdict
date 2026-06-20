import { BadRequestError } from "@assay/core";
import {
  type BenchmarkAdapterSpec,
  type FetchLike,
  getBenchmark,
  importBenchmark,
  importFromSpec,
  listBenchmarks,
} from "@assay/datasets";
import type { BenchmarkRegistry, DatasetRegistry } from "@assay/registry";

// 벤치마크 카탈로그(first-party 코드) + 테넌트 레시피(데이터, BenchmarkRegistry) → 테넌트-소유 Dataset 인입.
// 유저 셀프서비스: 카탈로그에서 고르거나, 자기 워크스페이스에 레시피(BenchmarkAdapterSpec)를 등록해 재사용. authZ 는 라우트.
export interface BenchmarkImportInput {
  tenant: string;
  benchmark?: string; // 카탈로그 id (first-party)
  recipe?: { id: string; version?: string }; // 등록된 테넌트/공유 레시피
  id?: string; // 대상 데이터셋 id (기본 = 소스 id)
  version: string;
  limit?: number;
  text?: string; // jsonl 소스 업로드 원문
}

export interface BenchmarkServiceDeps {
  datasets: DatasetRegistry;
  benchmarks?: BenchmarkRegistry; // 테넌트 레시피 레지스트리(없으면 레시피 기능 비활성)
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // gated 벤치마크용 HF_TOKEN
  fetchImpl?: FetchLike; // 테스트 주입
}

export class BenchmarkService {
  constructor(private readonly deps: BenchmarkServiceDeps) {}

  // first-party 카탈로그(코드).
  list(): ReturnType<typeof listBenchmarks> {
    return listBenchmarks();
  }

  private registry(): BenchmarkRegistry {
    if (!this.deps.benchmarks) {
      throw new BadRequestError("BAD_REQUEST", undefined, "benchmark 레시피 레지스트리가 설정되지 않았습니다.");
    }
    return this.deps.benchmarks;
  }

  // 테넌트 레시피 등록(데이터). 버전 불변(충돌 409). 자기 워크스페이스 소유.
  async registerRecipe(
    tenant: string,
    spec: BenchmarkAdapterSpec,
  ): Promise<{ workspace: string; id: string; version: string }> {
    await this.registry().register(tenant, spec);
    return { workspace: tenant, id: spec.id, version: spec.version };
  }

  // 테넌트 + _shared 레시피 목록.
  listRecipes(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.registry().list(tenant);
  }

  // 한 레시피(소유 우선/_shared 폴백). 없으면 NotFound(404).
  getRecipe(tenant: string, id: string, ref?: string): Promise<BenchmarkAdapterSpec> {
    return this.registry().get(tenant, id, ref);
  }

  // 인입 → 테넌트-소유 Dataset. recipe(등록된 데이터) 또는 benchmark(카탈로그 코드) 중 하나.
  async import(
    input: BenchmarkImportInput,
  ): Promise<{ workspace: string; id: string; version: string; cases: number }> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(input.tenant).catch(() => ({}))
      : {};
    const token = secrets.HF_TOKEN;
    const opts = {
      ...(input.limit ? { limit: input.limit } : {}),
      ...(token ? { token } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    };

    let dataset: Awaited<ReturnType<typeof importBenchmark>>;
    if (input.recipe) {
      const spec = await this.registry().get(input.tenant, input.recipe.id, input.recipe.version ?? "latest");
      dataset = await importFromSpec(
        spec,
        {
          id: input.id ?? spec.id,
          version: input.version,
          ...(spec.description ? { description: spec.description } : {}),
        },
        opts,
      );
    } else if (input.benchmark) {
      let adapter: ReturnType<typeof getBenchmark>;
      try {
        adapter = getBenchmark(input.benchmark);
      } catch (e) {
        throw new BadRequestError(
          "BAD_REQUEST",
          { benchmark: input.benchmark },
          e instanceof Error ? e.message : String(e),
        );
      }
      dataset = await importBenchmark(
        adapter,
        { id: input.id ?? adapter.id, version: input.version, description: adapter.description },
        opts,
      );
    } else {
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "benchmark(카탈로그) 또는 recipe(레시피) 중 하나가 필요합니다.",
      );
    }
    await this.deps.datasets.register(input.tenant, dataset); // 버전 불변(충돌 409)
    return { workspace: input.tenant, id: dataset.id, version: dataset.version, cases: dataset.cases.length };
  }
}
