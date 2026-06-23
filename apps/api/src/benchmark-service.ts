import { BadRequestError } from "@assay/core";
import {
  type BenchmarkAdapterSpec,
  BenchmarkAdapterSpecSchema,
  BenchmarkSourceSchema,
  type BenchmarkSourceSpec,
  type FetchLike,
  type HfDatasetHit,
  type HfSplit,
  fetchHfSplits,
  fetchSourceRows,
  getBenchmark,
  importBenchmark,
  importFromSpec,
  listBenchmarks,
  searchHfDatasets,
} from "@assay/datasets";
import type { BenchmarkRegistry, DatasetRegistry } from "@assay/registry";
import { z } from "zod";

// 벤치마크 인입 본문 — spec(인라인 정의/위저드) · benchmark(카탈로그) · recipe(등록된 레시피) 중 하나로 데이터셋 등록.
// HTTP 라우트와 MCP 툴이 공유(BFF↔MCP 패리티: 검증 스키마는 서비스 옆에 둔다).
export const BenchmarkImportBodySchema = z
  .object({
    spec: BenchmarkAdapterSpecSchema.optional(), // 인라인 정의(위저드) — 레시피 등록 없이 한 번에 인입
    benchmark: z.string().optional(), // 카탈로그 id (first-party)
    recipe: z.object({ id: z.string(), version: z.string().optional() }).optional(), // 등록된 레시피
    id: z.string().optional(), // 대상 데이터셋 id (기본 = 소스 id)
    version: z.string().default("1.0.0"),
    limit: z.number().int().positive().max(1000).optional(),
    text: z.string().optional(), // jsonl 소스 업로드 원문
  })
  .refine((b) => Boolean(b.spec) || Boolean(b.benchmark) || Boolean(b.recipe), {
    message: "spec(인라인 정의) · benchmark(카탈로그) · recipe(레시피) 중 하나가 필요합니다.",
  });

// 소스 미리보기 본문 — 매핑 전 원본 행 N개 + 감지된 필드(위저드용). 등록 없음.
export const BenchmarkPreviewBodySchema = z.object({
  source: BenchmarkSourceSchema,
  text: z.string().optional(), // jsonl 소스 원문
  limit: z.number().int().positive().max(20).optional(),
});

// 벤치마크 카탈로그(first-party 코드) + 테넌트 레시피(데이터, BenchmarkRegistry) → 테넌트-소유 Dataset 인입.
// 유저 셀프서비스: 카탈로그에서 고르거나, 자기 워크스페이스에 레시피(BenchmarkAdapterSpec)를 등록해 재사용. authZ 는 라우트.
export interface BenchmarkImportInput {
  tenant: string;
  createdBy?: string; // 인입한 subject — 생성된 데이터셋의 생성자(소프트 삭제 권한)
  spec?: BenchmarkAdapterSpec; // 인라인 정의(위저드) — 레시피 등록 없이 한 번에 인입
  benchmark?: string; // 카탈로그 id (first-party)
  recipe?: { id: string; version?: string }; // 등록된 테넌트/공유 레시피
  id?: string; // 대상 데이터셋 id (기본 = 소스 id)
  version: string;
  limit?: number;
  text?: string; // jsonl 소스 업로드 원문
}

export interface PreviewSourceInput {
  tenant: string;
  source: BenchmarkSourceSpec;
  text?: string; // jsonl 소스 원문(앞 N줄만 파싱)
  limit?: number;
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

  // 이 테넌트가 직접 등록한 버전만(폴백 없음) — validate dry-run 의 충돌 판정용.
  recipeOwnVersions(tenant: string, id: string): Promise<string[]> {
    return this.registry().ownVersions(tenant, id);
  }

  // HF Hub 데이터셋 검색 — 위저드가 정확한 id 대신 검색어로 후보를 고른다(raw 입력 회피). gated 인출은 HF_TOKEN.
  async searchHf(tenant: string, query: string, limit?: number): Promise<HfDatasetHit[]> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(tenant).catch(() => ({}))
      : {};
    return searchHfDatasets(query, {
      ...(limit ? { limit } : {}),
      ...(secrets.HF_TOKEN ? { token: secrets.HF_TOKEN } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  // 선택한 HF 데이터셋의 config/split 조합 — 위저드 드롭다운용(split 직접 타이핑 회피).
  async hfSplits(tenant: string, dataset: string): Promise<HfSplit[]> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(tenant).catch(() => ({}))
      : {};
    return fetchHfSplits(dataset, {
      ...(secrets.HF_TOKEN ? { token: secrets.HF_TOKEN } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  // 소스 미리보기 — 매핑 전 원본 행 N개 + 감지된 필드 목록. 위저드가 이걸로 필드를 드롭다운에 채우고 매핑한다.
  // gated HF 는 테넌트 SecretStore 의 HF_TOKEN 으로 인증. 등록/쓰기는 없다(순수 인출).
  async previewSource(input: PreviewSourceInput): Promise<{ fields: string[]; rows: Array<Record<string, unknown>> }> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(input.tenant).catch(() => ({}))
      : {};
    const rows = await fetchSourceRows(input.source, {
      limit: input.limit ?? 5,
      ...(secrets.HF_TOKEN ? { token: secrets.HF_TOKEN } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { fields, rows };
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
    if (input.spec) {
      // 인라인 정의(위저드) — 레지스트리에 레시피를 먼저 등록할 필요 없이 바로 인입.
      dataset = await importFromSpec(
        input.spec,
        {
          id: input.id ?? input.spec.id,
          version: input.version,
          ...(input.spec.description ? { description: input.spec.description } : {}),
        },
        opts,
      );
    } else if (input.recipe) {
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
        "spec(인라인 정의) · benchmark(카탈로그) · recipe(레시피) 중 하나가 필요합니다.",
      );
    }
    await this.deps.datasets.register(input.tenant, dataset, input.createdBy); // 버전 불변(충돌 409); 생성자 = 인입한 subject
    return { workspace: input.tenant, id: dataset.id, version: dataset.version, cases: dataset.cases.length };
  }
}
