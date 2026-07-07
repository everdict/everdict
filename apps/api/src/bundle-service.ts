import type { Action } from "@everdict/auth";
import {
  ConflictError,
  DatasetSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  JudgeSpecSchema,
  ModelSpecSchema,
  RuntimeSpecSchema,
} from "@everdict/core";
import { BenchmarkAdapterSpecSchema } from "@everdict/datasets";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import { z } from "zod";
import type { BenchmarkService } from "./benchmark-service.js";

// Bundle — a manifest of existing specs scattered across registries (harness+benchmark+dataset+runtime+judge/model).
// "specializations are bundles" principle: specific harnesses/benchmarks like codex+pinch are registered via this bundle (pure data) — core unchanged.
// The applier is just thin orchestration that fans each section out to the existing per-type register() (no new abstraction/store).
export const BundleSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  harnessTemplates: z.array(HarnessTemplateSpecSchema).default([]),
  harnesses: z.array(HarnessInstanceSpecSchema).default([]), // instances (template + pins)
  benchmarkRecipes: z.array(BenchmarkAdapterSpecSchema).default([]), // source→dataset adapters (import is separate)
  datasets: z.array(DatasetSchema).default([]), // ready-to-run case bundles
  judges: z.array(JudgeSpecSchema).default([]),
  models: z.array(ModelSpecSchema).default([]),
  runtimes: z.array(RuntimeSpecSchema).default([]),
});
export type Bundle = z.infer<typeof BundleSchema>;

// Per-item apply result — the batch is never aborted. Re-applying the same content = ok (registry idempotency), conflicting content = conflict, registry not configured = skipped.
export const BundleItemStatusSchema = z.enum(["ok", "conflict", "error", "skipped"]);
export type BundleItemStatus = z.infer<typeof BundleItemStatusSchema>;
export interface BundleItemResult {
  kind: string; // harness-template | harness | benchmark-recipe | dataset | judge | model | runtime
  id: string;
  version: string;
  status: BundleItemStatus;
  message?: string;
}
export interface BundleApplyResult {
  id: string;
  version: string;
  results: BundleItemResult[];
}

// Derive the required authZ actions from the bundle contents — compose existing per-type gates with no new action (routes/MCP enforce each).
export function requiredActionsForBundle(bundle: Bundle): Action[] {
  const need = new Set<Action>();
  if (bundle.harnessTemplates.length > 0) need.add("templates:write");
  if (bundle.harnesses.length > 0) need.add("harnesses:register");
  if (bundle.datasets.length > 0) need.add("datasets:write");
  if (bundle.benchmarkRecipes.length > 0) need.add("datasets:write"); // a recipe = a dataset adapter
  if (bundle.judges.length > 0) need.add("judges:write");
  if (bundle.models.length > 0) need.add("models:write");
  if (bundle.runtimes.length > 0) need.add("runtimes:write");
  return [...need];
}

export interface BundleServiceDeps {
  harnessTemplates?: HarnessTemplateRegistry;
  harnessInstances?: HarnessInstanceRegistry;
  benchmarks?: BenchmarkService; // recipe registration (BenchmarkService.registerRecipe)
  datasets?: DatasetRegistry;
  judges?: JudgeRegistry;
  models?: ModelRegistry;
  runtimes?: RuntimeRegistry;
}

interface Registrable {
  id: string;
  version: string;
}

// Apply one section — call register per item and collect results. If register is unset, skipped (no registry).
async function applySection<T extends Registrable>(
  kind: string,
  items: T[],
  register: ((item: T) => Promise<void>) | undefined,
  results: BundleItemResult[],
): Promise<void> {
  for (const item of items) {
    const base = { kind, id: item.id, version: item.version };
    if (!register) {
      results.push({ ...base, status: "skipped", message: "registry is not configured." });
      continue;
    }
    try {
      await register(item);
      results.push({ ...base, status: "ok" });
    } catch (err) {
      // Immutable registry: re-registering the same content raises no exception (idempotent). Only re-registering different content raises ConflictError → distinguished as conflict.
      const status: BundleItemStatus = err instanceof ConflictError ? "conflict" : "error";
      results.push({ ...base, status, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

// Apply a bundle — fan each section out to the existing registry (idempotent, partial success). authZ is enforced by routes/MCP via requiredActionsForBundle.
export class BundleService {
  constructor(private readonly deps: BundleServiceDeps) {}

  async apply(tenant: string, createdBy: string | undefined, bundle: Bundle): Promise<BundleApplyResult> {
    const results: BundleItemResult[] = [];
    const { harnessTemplates, harnessInstances, benchmarks, datasets, judges, models, runtimes } = this.deps;

    await applySection(
      "harness-template",
      bundle.harnessTemplates,
      harnessTemplates ? (s) => harnessTemplates.register(tenant, s) : undefined,
      results,
    );
    await applySection(
      "harness",
      bundle.harnesses,
      harnessInstances ? (s) => harnessInstances.register(tenant, s) : undefined,
      results,
    );
    await applySection(
      "benchmark-recipe",
      bundle.benchmarkRecipes,
      benchmarks
        ? async (s) => {
            await benchmarks.registerRecipe(tenant, s);
          }
        : undefined,
      results,
    );
    await applySection(
      "dataset",
      bundle.datasets,
      datasets ? (d) => datasets.register(tenant, d, createdBy) : undefined,
      results,
    );
    await applySection("judge", bundle.judges, judges ? (s) => judges.register(tenant, s) : undefined, results);
    await applySection("model", bundle.models, models ? (s) => models.register(tenant, s) : undefined, results);
    await applySection("runtime", bundle.runtimes, runtimes ? (s) => runtimes.register(tenant, s) : undefined, results);

    return { id: bundle.id, version: bundle.version, results };
  }
}
