import {
  BadRequestError,
  type DatasetOrigin,
  type DatasetProvenance,
  type DatasetSourceRef,
} from "@everdict/contracts";
import {
  type BenchmarkAdapterSpec,
  BenchmarkAdapterSpecSchema,
  type BenchmarkOrigin,
  BenchmarkSourceSchema,
  type BenchmarkSourceSpec,
  type FetchLike,
  type HfDatasetHit,
  type HfSplit,
  fetchHfDataFiles,
  fetchHfSplits,
  fetchSourceRows,
  getBenchmark,
  importBenchmark,
  importFromSpec,
  listBenchmarks,
  searchHfDatasets,
} from "@everdict/datasets";
import type { BenchmarkRegistry, DatasetRegistry } from "@everdict/registry";
import { z } from "zod";

// Benchmark import body — register a dataset from one of spec (inline definition/wizard) · benchmark (catalog) · recipe (registered recipe).
// Shared by the HTTP route and the MCP tool (BFF↔MCP parity: the validation schema lives next to the service).
export const BenchmarkImportBodySchema = z
  .object({
    spec: BenchmarkAdapterSpecSchema.optional(), // inline definition (wizard) — import in one shot with no recipe registration
    benchmark: z.string().optional(), // catalog id (first-party)
    recipe: z.object({ id: z.string(), version: z.string().optional() }).optional(), // registered recipe
    id: z.string().optional(), // target dataset id (default = source id)
    version: z.string().default("1.0.0"),
    limit: z.number().int().positive().max(1000).optional(),
    text: z.string().optional(), // uploaded jsonl source text
  })
  .refine((b) => Boolean(b.spec) || Boolean(b.benchmark) || Boolean(b.recipe), {
    message: "One of spec (inline definition) · benchmark (catalog) · recipe (recipe) is required.",
  });

// Source preview body — N raw rows + detected fields before mapping (for the wizard). No registration.
export const BenchmarkPreviewBodySchema = z.object({
  source: BenchmarkSourceSchema,
  text: z.string().optional(), // jsonl source text
  limit: z.number().int().positive().max(20).optional(),
});

// Benchmark catalog (first-party code) + tenant recipes (data, BenchmarkRegistry) → import into a tenant-owned Dataset.
// User self-service: pick from the catalog, or register a recipe (BenchmarkAdapterSpec) in your own workspace and reuse it. authZ is in the route.
export interface BenchmarkImportInput {
  tenant: string;
  createdBy?: string; // the importing subject — the created dataset's creator (soft-delete permission)
  spec?: BenchmarkAdapterSpec; // inline definition (wizard) — import in one shot with no recipe registration
  benchmark?: string; // catalog id (first-party)
  recipe?: { id: string; version?: string }; // registered tenant/shared recipe
  id?: string; // target dataset id (default = source id)
  version: string;
  limit?: number;
  text?: string; // uploaded jsonl source text
}

export interface PreviewSourceInput {
  tenant: string;
  subject?: string; // requester — used for gated auth down to personal secrets (HF_TOKEN)
  source: BenchmarkSourceSpec;
  text?: string; // jsonl source text (only the first N lines are parsed)
  limit?: number;
}

export interface BenchmarkServiceDeps {
  datasets: DatasetRegistry;
  benchmarks?: BenchmarkRegistry; // tenant recipe registry (recipe features disabled if absent)
  // HF_TOKEN for gated benchmarks — passing a subject includes that user's "personal" secrets (personal-first merge). A member
  // who cannot touch workspace secrets (admin-only) can still import on their own by putting HF_TOKEN in their account secrets (self-service).
  secretsFor?: (tenant: string, subject?: string) => Promise<Record<string, string>>;
  fetchImpl?: FetchLike; // test injection
}

// BenchmarkSource → source reference for dataset lineage (+ canonical HF link). jsonl is pasted, so it has no source link.
function toSourceRef(source: BenchmarkSourceSpec): DatasetSourceRef {
  if (source.kind === "huggingface") {
    return {
      kind: "huggingface",
      dataset: source.dataset,
      ...(source.config ? { config: source.config } : {}),
      ...(source.split ? { split: source.split } : {}),
      ...(source.file ? { file: source.file } : {}),
      url: `https://huggingface.co/datasets/${source.dataset}`, // canonical link (dataset page)
    };
  }
  return { kind: "jsonl" };
}

// BenchmarkOrigin (a published benchmark's official provenance, a bag of optional fields) → DatasetOrigin. Copy only defined fields (exclude empties).
function toDatasetOrigin(origin: BenchmarkOrigin): DatasetOrigin | undefined {
  if (!origin) return undefined;
  const keys = [
    "homepage",
    "paper",
    "code",
    "data",
    "leaderboard",
    "authors",
    "license",
    "citation",
    "taskType",
  ] as const;
  const o: DatasetOrigin = {};
  for (const k of keys) {
    const v = origin[k];
    if (v) o[k] = v;
  }
  return Object.keys(o).length > 0 ? o : undefined;
}

export class BenchmarkService {
  constructor(private readonly deps: BenchmarkServiceDeps) {}

  // first-party catalog (code).
  list(): ReturnType<typeof listBenchmarks> {
    return listBenchmarks();
  }

  private registry(): BenchmarkRegistry {
    if (!this.deps.benchmarks) {
      throw new BadRequestError("BAD_REQUEST", undefined, "The benchmark recipe registry is not configured.");
    }
    return this.deps.benchmarks;
  }

  // Register a tenant recipe (data). Versions are immutable (conflict 409). Owned by your own workspace.
  async registerRecipe(
    tenant: string,
    spec: BenchmarkAdapterSpec,
  ): Promise<{ workspace: string; id: string; version: string }> {
    await this.registry().register(tenant, spec);
    return { workspace: tenant, id: spec.id, version: spec.version };
  }

  // Tenant + _shared recipe list.
  listRecipes(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.registry().list(tenant);
  }

  // A single recipe (owned-first / _shared fallback). NotFound (404) if absent.
  getRecipe(tenant: string, id: string, ref?: string): Promise<BenchmarkAdapterSpec> {
    return this.registry().get(tenant, id, ref);
  }

  // Only versions this tenant registered directly (no fallback) — for the validate dry-run's conflict decision.
  recipeOwnVersions(tenant: string, id: string): Promise<string[]> {
    return this.registry().ownVersions(tenant, id);
  }

  // HF Hub dataset search — the wizard picks candidates by search term instead of an exact id (avoids raw input). Gated fetch uses HF_TOKEN.
  async searchHf(tenant: string, query: string, limit?: number, subject?: string): Promise<HfDatasetHit[]> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(tenant, subject).catch(() => ({}))
      : {};
    return searchHfDatasets(query, {
      ...(limit ? { limit } : {}),
      ...(secrets.HF_TOKEN ? { token: secrets.HF_TOKEN } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  // The config/split combinations of the chosen HF dataset — for the wizard dropdown (avoids typing the split by hand).
  async hfSplits(tenant: string, dataset: string, subject?: string): Promise<HfSplit[]> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(tenant, subject).catch(() => ({}))
      : {};
    return fetchHfSplits(dataset, {
      ...(secrets.HF_TOKEN ? { token: secrets.HF_TOKEN } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  // Fallback for datasets not served by the viewer (datasets-server) — the list of data files (csv/jsonl/json) in the repo.
  // The wizard picks a file instead of config/split and fetches it directly (officeqa-style: a gated repo with no viewer).
  async hfFiles(tenant: string, dataset: string, subject?: string): Promise<string[]> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(tenant, subject).catch(() => ({}))
      : {};
    return fetchHfDataFiles(dataset, {
      ...(secrets.HF_TOKEN ? { token: secrets.HF_TOKEN } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  // Source preview — N raw rows + the list of detected fields before mapping. The wizard uses this to populate field dropdowns and map them.
  // Gated HF authenticates with the tenant SecretStore's HF_TOKEN. No registration/writes (pure fetch).
  async previewSource(input: PreviewSourceInput): Promise<{ fields: string[]; rows: Array<Record<string, unknown>> }> {
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(input.tenant, input.subject).catch(() => ({}))
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

  // Import → tenant-owned Dataset. Either recipe (registered data) or benchmark (catalog code).
  async import(
    input: BenchmarkImportInput,
  ): Promise<{ workspace: string; id: string; version: string; cases: number }> {
    // The importer (createdBy) is the requester — used for gated auth down to that user's personal HF_TOKEN.
    const secrets: Record<string, string> = this.deps.secretsFor
      ? await this.deps.secretsFor(input.tenant, input.createdBy).catch(() => ({}))
      : {};
    const token = secrets.HF_TOKEN;
    const opts = {
      ...(input.limit ? { limit: input.limit } : {}),
      ...(token ? { token } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    };

    let dataset: Awaited<ReturnType<typeof importBenchmark>>;
    let producedBy: DatasetProvenance | undefined; // import provenance — stamped as the basis for the dataset→recipe back-link.
    if (input.spec) {
      // Inline definition (wizard) — import directly, no need to register a recipe in the registry first.
      dataset = await importFromSpec(
        input.spec,
        {
          id: input.id ?? input.spec.id,
          version: input.version,
          ...(input.spec.description ? { description: input.spec.description } : {}),
        },
        opts,
      );
      // Etch lineage — record on the dataset the source the wizard already knows (HF dataset/file), with no extra input.
      const origin = toDatasetOrigin(input.spec.origin);
      producedBy = {
        via: "spec",
        id: input.spec.id,
        source: toSourceRef(input.spec.source),
        ...(origin ? { origin } : {}),
      };
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
      // Imported from a registered recipe — the resolved concrete version (spec.version) makes the back-link point at the exact version.
      const origin = toDatasetOrigin(spec.origin);
      producedBy = {
        via: "recipe",
        id: spec.id,
        version: spec.version,
        source: toSourceRef(spec.source),
        ...(origin ? { origin } : {}),
      };
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
      producedBy = { via: "catalog", id: input.benchmark, source: toSourceRef(adapter.source) };
    } else {
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "One of spec (inline definition) · benchmark (catalog) · recipe (recipe) is required.",
      );
    }
    const stamped = producedBy ? { ...dataset, producedBy } : dataset; // etch provenance onto the dataset (for back-reference)
    await this.deps.datasets.register(input.tenant, stamped, input.createdBy); // versions immutable (conflict 409); creator = the importing subject
    return { workspace: input.tenant, id: stamped.id, version: stamped.version, cases: stamped.cases.length };
  }
}
