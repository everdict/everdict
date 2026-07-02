import type { Action } from "@assay/auth";
import {
  ConflictError,
  DatasetSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  JudgeSpecSchema,
  MetricSpecSchema,
  ModelSpecSchema,
  RuntimeSpecSchema,
} from "@assay/core";
import { BenchmarkAdapterSpecSchema } from "@assay/datasets";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  MetricRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from "@assay/registry";
import { z } from "zod";
import type { BenchmarkService } from "./benchmark-service.js";

// 플러그인 번들 — 여러 레지스트리에 흩어진 기존 스펙들의 매니페스트(하니스+벤치마크+데이터셋+런타임+judge/model/metric).
// "특화물은 플러그인" 원칙: codex+pinch 같은 특정 하니스/벤치마크는 이 번들(순수 데이터)로 등록 — 코어 무변경.
// 설치기는 각 섹션을 기존 per-type register() 로 팬아웃하는 얇은 오케스트레이션일 뿐(새 추상화/스토어 없음).
export const PluginBundleSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  harnessTemplates: z.array(HarnessTemplateSpecSchema).default([]),
  harnesses: z.array(HarnessInstanceSpecSchema).default([]), // 인스턴스(template + pins)
  benchmarkRecipes: z.array(BenchmarkAdapterSpecSchema).default([]), // 소스→데이터셋 어댑터(인입은 별도)
  datasets: z.array(DatasetSchema).default([]), // 즉시 실행 가능한 케이스 번들
  judges: z.array(JudgeSpecSchema).default([]),
  models: z.array(ModelSpecSchema).default([]),
  metrics: z.array(MetricSpecSchema).default([]),
  runtimes: z.array(RuntimeSpecSchema).default([]),
});
export type PluginBundle = z.infer<typeof PluginBundleSchema>;

// 설치 결과(항목별) — 배치는 절대 중단하지 않는다. 같은 내용 재설치=ok(레지스트리 멱등), 충돌 내용=conflict, 레지스트리 미설정=skipped.
export const InstallStatusSchema = z.enum(["ok", "conflict", "error", "skipped"]);
export type InstallStatus = z.infer<typeof InstallStatusSchema>;
export interface InstallItemResult {
  kind: string; // harness-template | harness | benchmark-recipe | dataset | judge | model | metric | runtime
  id: string;
  version: string;
  status: InstallStatus;
  message?: string;
}
export interface PluginInstallResult {
  id: string;
  version: string;
  results: InstallItemResult[];
}

// 번들 내용으로부터 필요한 authZ 액션을 도출 — 새 액션 없이 기존 per-type 게이트를 조합(라우트/MCP 가 각각 강제).
export function requiredActionsForBundle(bundle: PluginBundle): Action[] {
  const need = new Set<Action>();
  if (bundle.harnessTemplates.length > 0) need.add("templates:write");
  if (bundle.harnesses.length > 0) need.add("harnesses:register");
  if (bundle.datasets.length > 0) need.add("datasets:write");
  if (bundle.benchmarkRecipes.length > 0) need.add("datasets:write"); // 레시피=데이터셋 어댑터
  if (bundle.judges.length > 0) need.add("judges:write");
  if (bundle.models.length > 0) need.add("models:write");
  if (bundle.metrics.length > 0) need.add("metrics:write");
  if (bundle.runtimes.length > 0) need.add("runtimes:write");
  return [...need];
}

export interface PluginServiceDeps {
  harnessTemplates?: HarnessTemplateRegistry;
  harnessInstances?: HarnessInstanceRegistry;
  benchmarks?: BenchmarkService; // 레시피 등록(BenchmarkService.registerRecipe)
  datasets?: DatasetRegistry;
  judges?: JudgeRegistry;
  models?: ModelRegistry;
  metrics?: MetricRegistry;
  runtimes?: RuntimeRegistry;
}

interface Registrable {
  id: string;
  version: string;
}

// 한 섹션 설치 — 항목마다 register 를 호출하고 결과를 수집한다. register 미설정이면 skipped(레지스트리 없음).
async function installSection<T extends Registrable>(
  kind: string,
  items: T[],
  register: ((item: T) => Promise<void>) | undefined,
  results: InstallItemResult[],
): Promise<void> {
  for (const item of items) {
    const base = { kind, id: item.id, version: item.version };
    if (!register) {
      results.push({ ...base, status: "skipped", message: "레지스트리가 설정되지 않았습니다." });
      continue;
    }
    try {
      await register(item);
      results.push({ ...base, status: "ok" });
    } catch (err) {
      // 불변 레지스트리: 같은 내용 재등록은 예외 없음(멱등). 다른 내용 재등록만 ConflictError → conflict 로 구분.
      const status: InstallStatus = err instanceof ConflictError ? "conflict" : "error";
      results.push({ ...base, status, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

// 플러그인 번들 설치 — 각 섹션을 기존 레지스트리로 팬아웃(멱등, 부분성공). authZ 는 라우트/MCP 가 requiredActionsForBundle 로 강제.
export class PluginService {
  constructor(private readonly deps: PluginServiceDeps) {}

  async install(tenant: string, createdBy: string | undefined, bundle: PluginBundle): Promise<PluginInstallResult> {
    const results: InstallItemResult[] = [];
    const { harnessTemplates, harnessInstances, benchmarks, datasets, judges, models, metrics, runtimes } = this.deps;

    await installSection(
      "harness-template",
      bundle.harnessTemplates,
      harnessTemplates ? (s) => harnessTemplates.register(tenant, s) : undefined,
      results,
    );
    await installSection(
      "harness",
      bundle.harnesses,
      harnessInstances ? (s) => harnessInstances.register(tenant, s) : undefined,
      results,
    );
    await installSection(
      "benchmark-recipe",
      bundle.benchmarkRecipes,
      benchmarks
        ? async (s) => {
            await benchmarks.registerRecipe(tenant, s);
          }
        : undefined,
      results,
    );
    await installSection(
      "dataset",
      bundle.datasets,
      datasets ? (d) => datasets.register(tenant, d, createdBy) : undefined,
      results,
    );
    await installSection("judge", bundle.judges, judges ? (s) => judges.register(tenant, s) : undefined, results);
    await installSection("model", bundle.models, models ? (s) => models.register(tenant, s) : undefined, results);
    await installSection("metric", bundle.metrics, metrics ? (s) => metrics.register(tenant, s) : undefined, results);
    await installSection(
      "runtime",
      bundle.runtimes,
      runtimes ? (s) => runtimes.register(tenant, s) : undefined,
      results,
    );

    return { id: bundle.id, version: bundle.version, results };
  }
}
