import { BadRequestError } from "@assay/core";
import { type FetchLike, getBenchmark, importBenchmark, listBenchmarks } from "@assay/datasets";
import type { DatasetRegistry } from "@assay/registry";

// 벤치마크 카탈로그 + 인입 — first-party 벤치마크(HF Hub 등)를 "ID 만으로" 당겨 테넌트-소유 Dataset 으로 등록.
// 유저 셀프서비스: web 에서 카탈로그를 보고 고른 벤치마크를 자기 워크스페이스 데이터셋으로 import. authZ 는 라우트가 게이트.
export interface BenchmarkImportInput {
  tenant: string;
  benchmark: string; // 카탈로그 id (예: "gsm8k", "mind2web")
  id?: string; // 대상 데이터셋 id (기본 = benchmark id)
  version: string;
  limit?: number; // 인출 행 수 상한
  text?: string; // jsonl 소스 벤치마크(webvoyager 등) 업로드 원문
}

export interface BenchmarkServiceDeps {
  datasets: DatasetRegistry;
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // gated 벤치마크용 HF_TOKEN (테넌트 SecretStore)
  fetchImpl?: FetchLike; // 테스트 주입
}

export class BenchmarkService {
  constructor(private readonly deps: BenchmarkServiceDeps) {}

  // 카탈로그(유저가 고를 수 있는 first-party 벤치마크 목록).
  list(): ReturnType<typeof listBenchmarks> {
    return listBenchmarks();
  }

  // 벤치마크 인입 → 테넌트-소유 Dataset 등록. HF 소스는 네트워크 인출(gated 면 HF_TOKEN), jsonl 소스는 text 필요.
  async import(
    input: BenchmarkImportInput,
  ): Promise<{ workspace: string; id: string; version: string; cases: number }> {
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
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(input.tenant).catch(() => ({}))
      : {};
    const token = secrets.HF_TOKEN;
    const dataset = await importBenchmark(
      adapter,
      { id: input.id ?? adapter.id, version: input.version, description: adapter.description },
      {
        ...(input.limit ? { limit: input.limit } : {}),
        ...(token ? { token } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      },
    );
    await this.deps.datasets.register(input.tenant, dataset); // 버전 불변(충돌 409)
    return { workspace: input.tenant, id: dataset.id, version: dataset.version, cases: dataset.cases.length };
  }
}
